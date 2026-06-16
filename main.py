import os
import tempfile
import subprocess
import imageio_ffmpeg
import scipy.signal
if not hasattr(scipy.signal, 'hann'):
    scipy.signal.hann = scipy.signal.windows.hann
from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
import librosa
import numpy as np

from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel
import yt_dlp

app = FastAPI(title="Aurora AI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
import torch
import soundfile as sf
from demucs.apply import apply_model
from demucs.pretrained import get_model

print("Checking hardware acceleration for Demucs...")
if torch.cuda.is_available():
    device = "cuda"
elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"
    print("WARNING: No GPU detected. Falling back to CPU. Separation will be slow!")

demucs_model = get_model('htdemucs_6s')
demucs_model.eval()
demucs_model.to(device)
print(f"Demucs Model loaded on {device.upper()}")

# Ensure stems directory exists
os.makedirs("stems", exist_ok=True)
# Mount the static files so Flutter can stream them via URL
app.mount("/stems", StaticFiles(directory="stems"), name="stems")

def estimate_key(y, sr):
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    chroma_vals = np.sum(chroma, axis=1)
    notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    root = notes[np.argmax(chroma_vals)]
    return f"{root} Major"

@app.post("/analyze")
async def analyze_audio(file: UploadFile = File(...)):
    try:
        ext = os.path.splitext(file.filename)[1]
        if not ext:
            ext = ".m4a"
            
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_audio:
            content = await file.read()
            temp_audio.write(content)
            input_path = temp_audio.name
            
        wav_path = input_path + "_converted.wav"
        
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([ffmpeg_exe, "-y", "-i", input_path, "-ar", "44100", "-ac", "1", wav_path], 
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        y, sr = librosa.load(wav_path, sr=None)
        
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo[0]) if isinstance(tempo, np.ndarray) else float(tempo)
        
        key = estimate_key(y, sr)
        
        os.remove(input_path)
        if os.path.exists(wav_path):
            os.remove(wav_path)
        
        return {
            "status": "success",
            "bpm": round(bpm, 1),
            "key": key,
            "chords": [
                {"rootNote": key.split(" ")[0], "quality": "maj", "startTime": 0.0, "endTime": 4.0, "confidence": 0.95}
            ]
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

import threading
import uuid
import shutil

jobs = {}

def process_separation_job(job_id, input_path, safe_name):
    try:
        jobs[job_id]["status"] = "processing"
        
        wav_path = os.path.join(tempfile.gettempdir(), f"{safe_name}.wav")
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([ffmpeg_exe, "-y", "-i", input_path, "-ar", "44100", "-ac", "2", wav_path], 
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        wav, sr = sf.read(wav_path)
        if len(wav.shape) == 1:
            wav = np.column_stack((wav, wav))
            
        tensor_wav = torch.tensor(wav.T, dtype=torch.float32).unsqueeze(0).to(device)
        
        with torch.no_grad():
            sources = apply_model(demucs_model, tensor_wav, shifts=1, split=True, overlap=0.25)
            
        sources = sources[0].cpu().numpy()
        
        out_folder = f"stems/htdemucs_6s/{safe_name}"
        os.makedirs(out_folder, exist_ok=True)
        
        stem_names = demucs_model.sources
        for i, name in enumerate(stem_names):
            stem_wav = sources[i].T
            stem_wav_path = os.path.join(out_folder, f"{name}.wav")
            stem_mp3_path = os.path.join(out_folder, f"{name}.mp3")
            
            sf.write(stem_wav_path, stem_wav, sr)
            subprocess.run([ffmpeg_exe, "-y", "-i", stem_wav_path, "-b:a", "320k", stem_mp3_path], 
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.remove(stem_wav_path)
        
        model_out_path = f"htdemucs_6s/{safe_name}"
        base_url = "/stems"
        urls = {
            "vocals": f"{base_url}/{model_out_path}/vocals.mp3",
            "drums": f"{base_url}/{model_out_path}/drums.mp3",
            "bass": f"{base_url}/{model_out_path}/bass.mp3",
            "guitar": f"{base_url}/{model_out_path}/guitar.mp3",
            "piano": f"{base_url}/{model_out_path}/piano.mp3",
            "other": f"{base_url}/{model_out_path}/other.mp3"
        }
        
        if os.path.exists(wav_path):
            os.remove(wav_path)
            
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["urls"] = urls
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = str(e)
    finally:
        if os.path.exists(input_path):
            os.remove(input_path)


@app.post("/separate")
async def separate_audio(file: UploadFile = File(...)):
    try:
        ext = os.path.splitext(file.filename)[1]
        base_filename = os.path.splitext(file.filename)[0]
        
        import re
        safe_name = re.sub(r'[^\w\-]', '_', base_filename)
        if not safe_name:
            safe_name = "audio_track"
            
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_audio:
            content = await file.read()
            temp_audio.write(content)
            input_path = temp_audio.name
            
        job_id = str(uuid.uuid4())
        jobs[job_id] = {"status": "queued", "safe_name": safe_name}
        
        thread = threading.Thread(target=process_separation_job, args=(job_id, input_path, safe_name))
        thread.start()
        
        return {"status": "success", "job_id": job_id}
    except Exception as e:
        return {"status": "error", "message": str(e)}

class YouTubeRequest(BaseModel):
    url: str

@app.post("/youtube")
async def separate_youtube(req: YouTubeRequest):
    try:
        job_id = str(uuid.uuid4())
        
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': f'{tempfile.gettempdir()}/%(id)s.%(ext)s',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            }],
            'quiet': True,
            'ffmpeg_location': ffmpeg_exe
        }
        
        import re
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=True)
            video_title = info.get('title', 'YouTube Audio')
            safe_name = re.sub(r'[^\w\-]', '_', video_title)[:50]
            if not safe_name: safe_name = f"youtube_{job_id[:8]}"
            input_path = f"{tempfile.gettempdir()}/{info['id']}.mp3"
            
        jobs[job_id] = {"status": "queued", "safe_name": safe_name}
        
        thread = threading.Thread(target=process_separation_job, args=(job_id, input_path, safe_name))
        thread.start()
        
        return {"status": "success", "job_id": job_id}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/status/{job_id}")
def get_job_status(job_id: str):
    if job_id not in jobs:
        return {"status": "error", "message": "Job not found"}
    return jobs[job_id]

@app.delete("/job/{job_id}")
def delete_job(job_id: str):
    if job_id in jobs:
        safe_name = jobs[job_id].get("safe_name")
        if safe_name:
            out_folder = f"stems/htdemucs_6s/{safe_name}"
            if os.path.exists(out_folder):
                shutil.rmtree(out_folder)
        del jobs[job_id]
    return {"status": "success"}

@app.get("/history")
def get_history():
    out_dir = "stems/htdemucs_6s"
    if not os.path.exists(out_dir):
        return {"status": "success", "tracks": []}
        
    tracks = []
    base_url = "/stems"
    for folder in os.listdir(out_dir):
        folder_path = os.path.join(out_dir, folder)
        if os.path.isdir(folder_path):
            if os.path.exists(os.path.join(folder_path, "vocals.mp3")):
                model_out_path = f"htdemucs_6s/{folder}"
                urls = {
                    "vocals": f"{base_url}/{model_out_path}/vocals.mp3",
                    "drums": f"{base_url}/{model_out_path}/drums.mp3",
                    "bass": f"{base_url}/{model_out_path}/bass.mp3",
                    "guitar": f"{base_url}/{model_out_path}/guitar.mp3",
                    "piano": f"{base_url}/{model_out_path}/piano.mp3",
                    "other": f"{base_url}/{model_out_path}/other.mp3"
                }
                display_name = folder.replace("_", " ")
                tracks.append({"id": folder, "title": display_name, "urls": urls})
                
    return {"status": "success", "tracks": tracks}

os.makedirs("frontend", exist_ok=True)
if not os.path.exists("frontend/index.html"):
    with open("frontend/index.html", "w") as f:
        f.write("<h1>MsdChords Web App Loading...</h1>")

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
