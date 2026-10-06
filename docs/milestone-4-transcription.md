# Milestone 4: Local-Only faster-whisper Transcription Proof of Concept

This document describes the design, setup, execution, cleanup, and security controls for Milestone 4 of LectureVault.

---

## 1. Objectives & Security Boundaries

- **Zero Cloud Leakage**: Audio files and transcriptions are strictly processed locally on the host machine.
- **No External APIs**: Zero calls to external cloud transcription APIs (OpenAI, Google Speech, AssemblyAI, etc.).
- **No Direct Collab2 Stream Fetching**: The transcriber does not interact with Collaborate, cookies, tokens, or network media streams.
- **Strict Local Path Restriction**: Input files must reside within the `./data/` folder and have allowed audio extensions (`.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.flac`). All remote URLs, UNC network paths, and traversal attempts are rejected.
- **Git Exclusions**: Audio files (`data/audio/*`), transcripts (`data/transcripts/*`), downloaded model weights (`data/models/*`), and virtual environments (`.venv/`) are excluded in `.gitignore`.

---

## 2. Environment Setup & Dependencies

Milestone 4 utilizes Python 3.12 within a project-local virtual environment:

### Setup (one-time)
```powershell
# Create project-local virtual environment
python -m venv .venv

# Activate environment and install dependencies
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install faster-whisper
```

### Model Storage
By default, model weights (such as `small`, `int8`) are downloaded on first run and stored locally under:
```
data/models/
```
These weights remain completely offline for subsequent runs and are never tracked by Git.

---

## 3. Running Transcription

### CLI Command
You can transcribe any local audio file residing in `data/` using the TypeScript CLI wrapper:

```powershell
npm run transcribe:test -- --input "data/audio/<your-audio-file>.wav"
```

### Optional Flags
- `--model <name>`: Model size (`tiny`, `base`, `small`, `medium`, `large-v3`). Default: `small`.
- `--device <cpu|cuda>`: Compute device. Default: `cpu`.
- `--compute-type <int8|float16>`: Precision. Default: `int8` (optimized for CPU).
- `--language <es|en|...>`: Audio language. Default: `es`.
- `--beam-size <n>`: Beam size for beam search decoding. Default: `5`.

### Example Execution
```powershell
npm run transcribe:test -- --input "data/audio/synthetic-fixture-test.wav" --model "tiny"
```

---

## 4. Generated Output Files

Each transcription produces a directory named after the recording under `data/transcripts/<recording-id>/`:

| File | Description |
|------|-------------|
| `<recording-id>.txt` | Clean plain-text transcript, line-separated by speech segment. |
| `<recording-id>.srt` | SubRip subtitle format with `HH:MM:SS,mmm` timestamps. |
| `<recording-id>.vtt` | WebVTT format with `HH:MM:SS.mmm` timestamps. |
| `<recording-id>.json` | Structured JSON containing metadata (model, duration, RTF, segment count) and word/segment timestamps. |

### Sample JSON Structure
```json
{
  "recordingId": "sample-recording",
  "audioFile": "sample-recording.wav",
  "model": "small",
  "device": "cpu",
  "computeType": "int8",
  "detectedLanguage": "es",
  "languageProbability": 0.99,
  "audioDurationSeconds": 300.0,
  "processingDurationSeconds": 95.4,
  "realTimeFactor": 0.318,
  "segmentCount": 42,
  "timestamp": "2026-10-05T15:21:00Z",
  "segments": [
    {
      "id": 1,
      "seek": 0,
      "start": 0.0,
      "end": 4.5,
      "text": "Bienvenidos a la clase de hoy.",
      "avg_logprob": -0.21,
      "compression_ratio": 1.15,
      "no_speech_prob": 0.02
    }
  ]
}
```

---

## 5. Testing & Verification

1. **TypeScript Unit Tests**:
   ```powershell
   npm test
   ```
   Validates path restriction security, rejection of URLs, UNC network paths, traversal attacks, and extension filtering.

2. **Python Unit Tests**:
   ```powershell
   .\.venv\Scripts\python.exe -m unittest tests/test_transcribe.py
   ```
   Validates timestamp formatters (SRT/VTT) and path boundary enforcement.

3. **End-to-End Synthetic Fixture Test**:
   ```powershell
   npm run transcribe:test -- --input "data/audio/synthetic-fixture-test.wav" --model "tiny"
   ```

---

## 6. Cleanup

To remove local test transcripts or models without affecting project dependencies:
```powershell
# Remove generated transcripts
Remove-Item -Recurse -Force data/transcripts/*

# Remove test audio fixtures
Remove-Item data/audio/synthetic-fixture-test.wav

# Optional: Remove cached Whisper models to free disk space
Remove-Item -Recurse -Force data/models/*
```
