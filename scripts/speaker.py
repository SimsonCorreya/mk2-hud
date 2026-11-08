# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "piper-tts>=1.8,<2",
#   # onnxruntime 1.21 and later take about 8 s, not 2 s, to load a voice on
#   # some CPUs (seen on a Ryzen 7 1700).
#   "onnxruntime==1.20.1",
#   "sounddevice>=0.5,<1",
#   "numpy>=1.26",
# ]
# ///
"""Reads text aloud with a Piper neural voice, for the read-aloud mod.

One process serves a whole Claude Code session, so the voice loads once. The
mod writes each reading to <dir>/<reading>.txt, one sentence per line, and
steers playback through <dir>/<session>.ctl.json, which this polls:

    { reading, paused, speed, volume (0-100), voice, seek, seekSeq, stop, quit }

A new `reading` starts that text at `seek`; a new `seekSeq` jumps to `seek`.
Progress goes to stdout, one line each: READY, END <reading>, ERR <message>,
START <reading> <index> <duration ms> <offset ms> <loudness>, and
PAUSED / RESUMED <reading> <position ms>. Loudness is one digit 0-9 per 50 ms
of the sentence, what the mod's mascot moves its mouth to.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import numpy as np
import sounddevice as sd
from piper import PiperVoice, SynthesisConfig

POLL_SECONDS = 0.04
IDLE_EXIT_SECONDS = 20 * 60
# Silence after each sentence, at normal speed, so the voice breathes.
SENTENCE_GAP_SECONDS = 0.28
LOUDNESS_STEP_SECONDS = 0.05


def say(*parts: object) -> None:
    print(" ".join(str(part) for part in parts), flush=True)


def is_parent_alive(parent: int) -> bool:
    """False once the process that started this one (Claude Code) is gone."""
    if os.name != "nt":
        return os.getppid() == parent
    kernel = ctypes.windll.kernel32
    handle = kernel.OpenProcess(0x00100000, False, parent)  # SYNCHRONIZE
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(handle, 0) != 0  # WAIT_OBJECT_0: exited
    finally:
        kernel.CloseHandle(handle)


class VoiceLock:
    """One voice on this computer at a time, shared by every session's speaker.

    Each Claude Code session runs its own speaker; without this, two sessions
    that finish replies close together read over each other, which sounds like
    gibberish. The lock is the operating system's, on one byte of a file in the
    shared folder, so it is let go even when a speaker is killed.
    """

    def __init__(self, path: Path) -> None:
        self._fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
        self.held = False

    def acquire(self) -> bool:
        if self.held:
            return True
        try:
            os.lseek(self._fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False  # another session is speaking
        self.held = True
        return True

    def release(self) -> None:
        if not self.held:
            return
        try:
            os.lseek(self._fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        self.held = False

    def close(self) -> None:
        self.release()
        os.close(self._fd)


class Player:
    """Plays one sentence on the default output device; a pause holds the place."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._samples = np.zeros(0, dtype=np.float32)
        self._position = 0
        self._stream: sd.OutputStream | None = None
        self._rate = 0
        self.paused = False
        # Held silent, in place, while another session's reading has the voice.
        self.waiting = False
        self.volume = 1.0

    def _fill(self, out: np.ndarray, frames: int, _time: object, _status: object) -> None:
        with self._lock:
            if self.paused or self.waiting or self._position >= len(self._samples):
                out.fill(0)
                return
            chunk = self._samples[self._position : self._position + frames]
            self._position += len(chunk)
        out[: len(chunk), 0] = chunk * self.volume
        out[len(chunk) :, 0] = 0

    def play(self, samples: np.ndarray, rate: int, position: int = 0) -> None:
        if self._stream is None or rate != self._rate:
            self.close()
            self._stream = sd.OutputStream(
                samplerate=rate, channels=1, dtype="float32", callback=self._fill
            )
            self._stream.start()
            self._rate = rate
        with self._lock:
            self._samples = samples
            self._position = min(position, len(samples))

    def clear(self) -> None:
        with self._lock:
            self._samples = np.zeros(0, dtype=np.float32)
            self._position = 0

    @property
    def progress(self) -> float:
        with self._lock:
            return self._position / len(self._samples) if len(self._samples) else 0.0

    @property
    def is_done(self) -> bool:
        with self._lock:
            return len(self._samples) > 0 and self._position >= len(self._samples)

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class Voices:
    """The Piper voices in one folder; one is kept loaded at a time."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self._name = ""
        self._voice: PiperVoice | None = None

    def names(self) -> list[str]:
        return sorted(path.stem for path in self.folder.glob("*.onnx"))

    def get(self, name: str) -> PiperVoice:
        if self._voice is None or name != self._name:
            self._voice = PiperVoice.load(self.folder / f"{name}.onnx")
            self._name = name
        return self._voice


def loudness(samples: np.ndarray, rate: int) -> str:
    """How loud each 50 ms of a sentence is, as digits 0-9 against its peak."""
    step = max(1, int(rate * LOUDNESS_STEP_SECONDS))
    count = max(1, -(-len(samples) // step))
    padded = np.zeros(count * step, dtype=np.float32)
    padded[: len(samples)] = samples
    rms = np.sqrt(np.mean(padded.reshape(count, step) ** 2, axis=1))
    peak = float(rms.max()) or 1.0
    share = rms / peak
    digits = np.where(share < 0.08, 0, np.clip(np.round(9 * share**0.7), 1, 9)).astype(int)
    return "".join(str(digit) for digit in digits)


def render(voice: PiperVoice, text: str, speed: float) -> tuple[np.ndarray, int, str]:
    config = SynthesisConfig(length_scale=(voice.config.length_scale or 1.0) / speed)
    chunks = list(voice.synthesize(text, syn_config=config))
    rate = chunks[0].sample_rate if chunks else voice.config.sample_rate
    gap = np.zeros(int(rate * SENTENCE_GAP_SECONDS / speed), dtype=np.float32)
    parts = [np.asarray(chunk.audio_float_array, dtype=np.float32).reshape(-1) for chunk in chunks]
    samples = np.concatenate([*parts, gap])
    return samples, rate, loudness(samples, rate)


def clamp(value: object, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, type=Path)
    parser.add_argument("--session", required=True)
    parser.add_argument("--voices", required=True, type=Path)
    parser.add_argument("--default-voice", default="")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[union-attr]

    parent = os.getppid()
    control_path: Path = args.dir / f"{args.session}.ctl.json"
    voice_lock = VoiceLock(args.dir / "speaking.lock")
    voices = Voices(args.voices)
    names = voices.names()
    if not names:
        say("ERR no Piper voices in", args.voices)
        return 1
    default_voice = args.default_voice if args.default_voice in names else names[0]
    render(voices.get(default_voice), "Ready.", 1.0)  # loads the voice and warms it up
    say("READY")

    executor = ThreadPoolExecutor(max_workers=1)
    pending: dict[tuple[str, int, str, float], Future[tuple[np.ndarray, int, str]]] = {}
    player = Player()
    control: dict[str, object] = {}
    control_text = ""
    reading = ""
    sentences: list[str] = []
    index = 0
    seek_seq: object = None
    voice_name = default_voice
    speed = 1.0
    playing: tuple[str, int, str, float] | None = None
    resume_at = 0.0
    # How long the sentence being played lasts, for the positions reported.
    playing_ms = 0
    is_live = False
    idle_since = time.monotonic()
    parent_checked = 0.0

    def request(at: int) -> Future[tuple[np.ndarray, int, str]] | None:
        if not 0 <= at < len(sentences):
            return None
        key = (reading, at, voice_name, speed)
        if key not in pending:
            text = sentences[at]
            name, pace = voice_name, speed
            pending[key] = executor.submit(lambda: render(voices.get(name), text, pace))
        return pending[key]

    def finish() -> None:
        nonlocal is_live, playing, idle_since
        for future in pending.values():
            future.cancel()
        pending.clear()
        player.clear()
        player.close()
        voice_lock.release()
        playing = None
        is_live = False
        idle_since = time.monotonic()
        (args.dir / f"{reading}.txt").unlink(missing_ok=True)
        say("END", reading)

    try:
        while True:
            now = time.monotonic()
            if now - parent_checked > 2:
                parent_checked = now
                if not is_parent_alive(parent):
                    break

            try:
                text = control_path.read_text(encoding="utf-8")
                if text != control_text:
                    control = json.loads(text)
                    control_text = text
            except (OSError, ValueError):
                pass  # not there yet, or half written: read it again next poll
            if control.get("quit"):
                break

            wanted = str(control.get("reading") or "")
            if wanted != reading:
                if is_live:
                    finish()
                reading = wanted
                seek_seq = control.get("seekSeq")
                index = int(clamp(control.get("seek"), 0, 1e9, 0))
                resume_at = 0.0
                try:
                    lines = (args.dir / f"{reading}.txt").read_text(encoding="utf-8").splitlines()
                    sentences = [line.strip() for line in lines if line.strip()]
                    is_live = reading != "" and not control.get("stop")
                except OSError:
                    sentences = []
                    is_live = False

            if not is_live:
                if now - idle_since > IDLE_EXIT_SECONDS:
                    break
                time.sleep(POLL_SECONDS)
                continue
            if control.get("stop"):
                finish()
                continue

            player.volume = clamp(control.get("volume"), 0, 100, 100) / 100
            if control.get("seekSeq") != seek_seq:
                seek_seq = control.get("seekSeq")
                index = int(clamp(control.get("seek"), 0, len(sentences), 0))
                playing = None
                resume_at = 0.0
                player.clear()

            name = str(control.get("voice") or default_voice)
            if name not in names:
                names = voices.names()
                name = name if name in names else default_voice
            pace = clamp(control.get("speed"), 0.5, 3, 1)
            if (name, pace) != (voice_name, speed):
                # The sentence being read carries on from the same point, in the
                # new voice or at the new speed.
                if playing is not None:
                    resume_at = player.progress
                    playing = None
                for future in pending.values():
                    future.cancel()
                pending.clear()
                voice_name, speed = name, pace

            paused = bool(control.get("paused"))
            if paused != player.paused:
                player.paused = paused
                position = int(player.progress * playing_ms) if playing is not None else 0
                say("PAUSED" if paused else "RESUMED", reading, position)

            # A reading takes the voice for all its sentences and waits, silent,
            # while another session's reading has it; a paused one lets it go.
            if player.paused:
                voice_lock.release()
            elif not voice_lock.acquire():
                player.waiting = True
                if playing is None:
                    request(index)  # ready to start the moment the voice is free
                time.sleep(POLL_SECONDS)
                continue
            player.waiting = False

            if playing is None:
                if index >= len(sentences):
                    finish()
                    continue
                future = request(index)
                if future is not None and future.done():
                    try:
                        samples, rate, envelope = future.result()
                    except Exception as error:  # a voice that fails to load or speak
                        say("ERR", error)
                        finish()
                        continue
                    player.play(samples, rate, int(resume_at * len(samples)))
                    playing_ms = int(len(samples) / rate * 1000)
                    say("START", reading, index, playing_ms, int(resume_at * playing_ms), envelope or "0")
                    resume_at = 0.0
                    playing = (reading, index, voice_name, speed)
                    for key in [key for key in pending if key[1] < index]:
                        del pending[key]
                    request(index + 1)
            elif player.is_done:
                index += 1
                playing = None
                continue

            time.sleep(POLL_SECONDS)
    finally:
        player.close()
        voice_lock.close()
        executor.shutdown(wait=False, cancel_futures=True)
        control_path.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
