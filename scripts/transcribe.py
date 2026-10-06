import os
import sys
import json
import time
import argparse
from pathlib import Path
from faster_whisper import WhisperModel

def format_timestamp(seconds: float, vtt: bool = False) -> str:
    millis = int(round(seconds * 1000))
    hours = millis // (3600 * 1000)
    millis %= (3600 * 1000)
    minutes = millis // (60 * 1000)
    millis %= (60 * 1000)
    secs = millis // 1000
    millis %= 1000

    if vtt:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def validate_audio_file(audio_path: str, data_root: Path) -> Path:
    p = Path(audio_path).resolve()
    
    # Must exist
    if not p.is_file():
        raise ValueError(f"Audio file does not exist: {p}")
        
    # Must be inside data directory
    try:
        p.relative_to(data_root.resolve())
    except ValueError:
        raise ValueError(f"Security restriction: audio file must be inside {data_root.resolve()}, got: {p}")
        
    # Check valid extensions
    valid_exts = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"}
    if p.suffix.lower() not in valid_exts:
        raise ValueError(f"Unsupported media format '{p.suffix}'. Supported: {', '.join(sorted(valid_exts))}")
        
    return p

def run_transcription():
    parser = argparse.ArgumentParser(description="Local faster-whisper transcription engine")
    parser.add_argument("--input", required=True, help="Path to local audio file")
    parser.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    parser.add_argument("--device", default="cpu", help="Compute device: cpu or cuda (default: cpu)")
    parser.add_argument("--compute_type", default="int8", help="Compute type: int8, float16, etc. (default: int8)")
    parser.add_argument("--language", default="es", help="Audio language code (default: es)")
    parser.add_argument("--beam_size", type=int, default=5, help="Beam size (default: 5)")
    parser.add_argument("--vad_filter", action="store_true", default=True, help="Enable Silero VAD filter")
    parser.add_argument("--output_dir", default="", help="Directory for transcript outputs")
    parser.add_argument("--model_dir", default="./data/models", help="Directory where model weights are stored")

    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    data_root = project_root / "data"

    audio_file = validate_audio_file(args.input, data_root)
    recording_id = audio_file.stem

    if args.output_dir:
        out_dir = Path(args.output_dir).resolve()
    else:
        out_dir = data_root / "transcripts" / recording_id

    out_dir.mkdir(parents=True, exist_ok=True)
    model_storage_dir = Path(args.model_dir).resolve()
    model_storage_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading faster-whisper model '{args.model}' (device={args.device}, compute_type={args.compute_type})...")
    load_start = time.time()
    
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=str(model_storage_dir),
        cpu_threads=min(8, os.cpu_count() or 4)
    )
    print(f"Model loaded in {time.time() - load_start:.2f}s")

    print(f"Transcribing audio file: {audio_file.name}...")
    transcribe_start = time.time()

    segments_generator, info = model.transcribe(
        str(audio_file),
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter
    )

    segments_data = []
    plain_text_lines = []
    srt_lines = []
    vtt_lines = ["WEBVTT", ""]

    segment_idx = 1
    for seg in segments_generator:
        text = seg.text.strip()
        if not text:
            text = "[ininteligible]"

        segments_data.append({
            "id": seg.id,
            "seek": seg.seek,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": text,
            "avg_logprob": round(seg.avg_logprob, 3),
            "compression_ratio": round(seg.compression_ratio, 3),
            "no_speech_prob": round(seg.no_speech_prob, 3)
        })

        plain_text_lines.append(text)

        # SRT format
        srt_lines.append(str(segment_idx))
        srt_lines.append(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}")
        srt_lines.append(text)
        srt_lines.append("")

        # VTT format
        vtt_lines.append(f"{format_timestamp(seg.start, vtt=True)} --> {format_timestamp(seg.end, vtt=True)}")
        vtt_lines.append(text)
        vtt_lines.append("")

        segment_idx += 1

    processing_duration = time.time() - transcribe_start
    audio_duration = round(info.duration, 2)
    real_time_factor = round(processing_duration / max(audio_duration, 0.001), 3)

    # 1. Plain text file
    txt_path = out_dir / f"{recording_id}.txt"
    txt_path.write_text("\n".join(plain_text_lines), encoding="utf-8")

    # 2. SRT subtitle file
    srt_path = out_dir / f"{recording_id}.srt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

    # 3. VTT subtitle file
    vtt_path = out_dir / f"{recording_id}.vtt"
    vtt_path.write_text("\n".join(vtt_lines), encoding="utf-8")

    # 4. JSON detailed metadata file
    meta_json = {
        "recordingId": recording_id,
        "audioFile": audio_file.name,
        "model": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "detectedLanguage": info.language,
        "languageProbability": round(info.language_probability, 3),
        "audioDurationSeconds": audio_duration,
        "processingDurationSeconds": round(processing_duration, 2),
        "realTimeFactor": real_time_factor,
        "segmentCount": len(segments_data),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "segments": segments_data
    }

    json_path = out_dir / f"{recording_id}.json"
    json_path.write_text(json.dumps(meta_json, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n" + "=" * 60)
    print("TRANSCRIPCIÓN LOCAL COMPLETADA (HITO 4)")
    print("=" * 60)
    print(f"• Archivo procesado:      {audio_file.name}")
    print(f"• Modelo whisper:         {args.model} ({args.device}, {args.compute_type})")
    print(f"• Idioma detectado:       {info.language} (probabilidad: {info.language_probability:.2f})")
    print(f"• Duración de audio:      {audio_duration:.1f} s ({audio_duration/60:.2f} min)")
    print(f"• Tiempo de proceso:      {processing_duration:.1f} s")
    print(f"• Factor tiempo real:     {real_time_factor:.3f}x")
    print(f"• Segmentos generados:    {len(segments_data)}")
    print(f"• Archivos guardados en:  {out_dir}")
    print(f"  - TXT:  {txt_path.name}")
    print(f"  - SRT:  {srt_path.name}")
    print(f"  - VTT:  {vtt_path.name}")
    print(f"  - JSON: {json_path.name}")
    print("=" * 60)

if __name__ == "__main__":
    try:
        run_transcription()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
