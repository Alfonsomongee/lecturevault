import wave
import math
import struct
from pathlib import Path

def create_synthetic_wav(filename: str, duration_sec: float = 2.0, sample_rate: int = 16000):
    p = Path(filename)
    p.parent.mkdir(parents=True, exist_ok=True)
    num_samples = int(duration_sec * sample_rate)
    
    with wave.open(str(p), 'w') as wf:
        wf.setnchannels(1)      # mono
        wf.setsampwidth(2)      # 16-bit
        wf.setframerate(sample_rate)
        
        # 440 Hz sine tone
        for i in range(num_samples):
            val = int(16000.0 * math.sin(2.0 * math.pi * 440.0 * (i / sample_rate)))
            wf.writeframes(struct.pack('<h', val))
            
    return p

if __name__ == "__main__":
    out = Path("data/audio/synthetic-fixture-test.wav")
    create_synthetic_wav(str(out), duration_sec=1.5)
    print(f"Synthetic test WAV created at: {out}")
