const uploadInput = document.getElementById('audio-upload');
const statusPanel = document.getElementById('status-panel');
const statusText = document.getElementById('status-text');
const mixerPanel = document.getElementById('mixer-panel');
const stemsContainer = document.getElementById('stems-container');
const masterPlayBtn = document.getElementById('master-play');
const masterProgress = document.getElementById('master-progress');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const historyList = document.getElementById('history-list');
const ytInput = document.getElementById('yt-input');
const ytBtn = document.getElementById('yt-btn');

const speedDown = document.getElementById('speed-down');
const speedUp = document.getElementById('speed-up');
const speedVal = document.getElementById('speed-val');

const pitchDown = document.getElementById('pitch-down');
const pitchUp = document.getElementById('pitch-up');
const pitchVal = document.getElementById('pitch-val');

const BASE_URL = '';
let stems = {}; // { id: { element: HTMLAudioElement, gainNode: GainNode, isMuted: false, isSolo: false, volume: 1.0, objectUrl: string } }
let isPlaying = false;
let globalDuration = 0;

let masterPitchShift;
let currentSpeed = 1.00;
let currentPitch = 0.00;

// Update UI Text
function updateFXUI() {
    speedVal.value = currentSpeed.toFixed(2) + 'x';
    pitchVal.value = (currentPitch > 0 ? '+' : '') + currentPitch.toFixed(2);
}

speedDown.onclick = () => { currentSpeed = Math.max(0.5, currentSpeed - 0.01); applyFX(); };
speedUp.onclick = () => { currentSpeed = Math.min(2.0, currentSpeed + 0.01); applyFX(); };
pitchDown.onclick = () => { currentPitch = Math.max(-12.0, currentPitch - 0.01); applyFX(); };
pitchUp.onclick = () => { currentPitch = Math.min(12.0, currentPitch + 0.01); applyFX(); };

// Keyboard Input Handlers
speedVal.addEventListener('change', (e) => {
    let val = parseFloat(e.target.value.replace('x', ''));
    if (!isNaN(val)) {
        currentSpeed = Math.max(0.5, Math.min(2.0, val));
    }
    applyFX();
});

pitchVal.addEventListener('change', (e) => {
    let val = parseFloat(e.target.value.replace('+', ''));
    if (!isNaN(val)) {
        currentPitch = Math.max(-12.0, Math.min(12.0, val));
    }
    applyFX();
});

function applyFX() {
    updateFXUI();
    
    // Apply Speed (playbackRate changes speed natively in browser)
    Object.values(stems).forEach(s => {
        if (s.element) {
            s.element.playbackRate = currentSpeed;
            s.element.preservesPitch = true; // HTML5 native preserves pitch
        }
    });

    // Apply Pitch (Tone.js changes independent pitch)
    if (masterPitchShift) {
        masterPitchShift.pitch = currentPitch;
    }
}

// Load History on Boot
window.addEventListener('DOMContentLoaded', loadHistory);

async function loadHistory() {
    try {
        const res = await fetch(`${BASE_URL}/history`);
        const data = await res.json();
        
        historyList.innerHTML = '';
        if (!data.tracks || data.tracks.length === 0) {
            historyList.innerHTML = '<p style="color: #888; font-size: 0.9rem;">No tracks found.</p>';
            return;
        }

        data.tracks.forEach(track => {
            const div = document.createElement('div');
            div.className = 'history-item';
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-item-title';
            titleSpan.innerText = track.title;
            titleSpan.onclick = () => {
                statusPanel.classList.remove('hidden');
                mixerPanel.classList.add('hidden');
                statusText.innerHTML = `<h2>Loading Audio...</h2><p>Syncing ${track.title}...</p>`;
                initializeMixer(track.urls);
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'history-del-btn';
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                // We use the /job/ track.id to delete from the python backend
                await fetch(`${BASE_URL}/job/${track.id}`, { method: 'DELETE' });
                loadHistory(); // refresh
            };

            div.appendChild(titleSpan);
            div.appendChild(delBtn);
            historyList.appendChild(div);
        });

    } catch (e) {
        console.error("Failed to load history", e);
    }
}

uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Reset UI
    mixerPanel.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    statusText.innerHTML = `<h2>Uploading...</h2><p>Sending ${file.name} to AI Engine</p>`;
    
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${BASE_URL}/separate`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        
        if (data.status === 'success') {
            pollStatus(data.job_id);
        } else {
            throw new Error(data.message);
        }
    } catch (err) {
        statusText.innerHTML = `<h2>Error</h2><p>${err.message}</p>`;
    }
});

ytBtn.addEventListener('click', async () => {
    const url = ytInput.value.trim();
    if (!url) return;
    
    ytInput.value = '';
    mixerPanel.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    statusText.innerHTML = `<h2>Downloading YouTube...</h2><p>Extracting audio from link...</p>`;
    
    try {
        const response = await fetch(`${BASE_URL}/youtube`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        });
        const data = await response.json();
        
        if (data.status === 'success') {
            pollStatus(data.job_id);
        } else {
            throw new Error(data.message);
        }
    } catch (err) {
        statusText.innerHTML = `<h2>Error</h2><p>${err.message}</p>`;
    }
});

async function pollStatus(jobId) {
    statusText.innerHTML = `<h2>Separating...</h2><p>Demucs AI is processing 6 stems on local GPU.</p>`;
    
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${BASE_URL}/status/${jobId}`);
            const data = await res.json();
            
            if (data.status === 'completed') {
                clearInterval(interval);
                statusText.innerHTML = `<h2>Loading Audio...</h2><p>Syncing 6 tracks...</p>`;
                await initializeMixer(data.urls);
                loadHistory(); // Refresh history with new track
            } else if (data.status === 'error') {
                clearInterval(interval);
                statusText.innerHTML = `<h2>Backend Error</h2><p>${data.message}</p>`;
            }
        } catch (err) {
            console.error(err);
        }
    }, 3000);
}

async function initializeMixer(urls) {
    // Stop old audio, revoke object URLs, and clean up Web Audio nodes
    Object.values(stems).forEach(s => {
        s.element.pause();
        s.element.removeAttribute('src');
        s.element.load();
        if (s.objectUrl) URL.revokeObjectURL(s.objectUrl);
        if (s.gainNode) {
            s.gainNode.disconnect();
        }
        if (s.trackSource) {
            s.trackSource.disconnect();
        }
    });
    
    stemsContainer.innerHTML = '';
    stems = {};
    isPlaying = false;
    masterPlayBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    
    const stemNames = Object.keys(urls);
    let loadedCount = 0;
    let hasError = false;

    // Tone.js Initialization
    await Tone.start();
    if (!masterPitchShift) {
        masterPitchShift = new Tone.PitchShift({ pitch: currentPitch, windowSize: 0.1 }).toDestination();
    }
    const audioCtx = Tone.getContext().rawContext;

    // Fetch all stems as Blobs to bypass Chrome's 6-connection limit and allow instant seeking
    for (const name of stemNames) {
        try {
            const response = await fetch(urls[name]);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            
            const audioEl = new Audio();
            audioEl.src = objectUrl;
            audioEl.playbackRate = currentSpeed;
            audioEl.preservesPitch = true;
            
            // Route to Tone.js
            const trackSource = audioCtx.createMediaElementSource(audioEl);
            const gainNode = audioCtx.createGain();
            trackSource.connect(gainNode);
            Tone.connect(gainNode, masterPitchShift);
            
            stems[name] = {
                element: audioEl,
                gainNode: gainNode,
                trackSource: trackSource,
                isMuted: false,
                isSolo: false,
                volume: 1.0,
                objectUrl: objectUrl // keep reference to revoke later
            };

        const card = document.createElement('div');
        card.className = 'stem-card';
        card.id = `card-${name}`;
        card.innerHTML = `
            <div class="stem-title">${name}</div>
            <div class="stem-slider-container">
                <input type="range" id="vol-${name}" min="0" max="1" step="0.01" value="1">
            </div>
            <div class="stem-controls">
                <button class="stem-btn" id="mute-${name}"><i class="fa-solid fa-volume-xmark"></i></button>
                <button class="stem-btn" id="solo-${name}">S</button>
            </div>
        `;
        stemsContainer.appendChild(card);

        document.getElementById(`vol-${name}`).addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            stems[name].volume = val;
            updateStemVolume();
        });

        document.getElementById(`mute-${name}`).addEventListener('click', () => {
            stems[name].isMuted = !stems[name].isMuted;
            document.getElementById(`mute-${name}`).classList.toggle('active-mute');
            document.getElementById(`card-${name}`).classList.toggle('muted');
            updateStemVolume();
        });

        document.getElementById(`solo-${name}`).addEventListener('click', () => {
            stems[name].isSolo = !stems[name].isSolo;
            document.getElementById(`solo-${name}`).classList.toggle('active-solo');
            updateStemVolume();
        });

        audioEl.addEventListener('loadedmetadata', () => {
            if (audioEl.dataset.loaded) return; // Prevent multiple triggers
            audioEl.dataset.loaded = "true";
            
            loadedCount++;
            console.log(`Loaded ${name}. Total loaded: ${loadedCount}/6`);
            if (loadedCount === stemNames.length && !hasError) {
                globalDuration = stems['vocals'].element.duration || stems['drums'].element.duration || 0;
                masterProgress.max = globalDuration;
                timeTotal.innerText = formatTime(globalDuration);
                
                statusPanel.classList.add('hidden');
                mixerPanel.classList.remove('hidden');
            }
        });
        
        audioEl.addEventListener('error', (e) => {
            hasError = true;
            statusText.innerHTML = `<h2>Audio Error</h2><p>Failed to load ${name}.mp3</p>`;
            console.error("Audio Load Error:", e);
        });

        audioEl.load();
        } catch (fetchError) {
            hasError = true;
            statusText.innerHTML = `<h2>Download Error</h2><p>Failed to download ${name}.mp3 from server.</p>`;
            console.error("Fetch Error:", fetchError);
        }
    }
    
    // UI Progress Sync (bound only to vocals since they all play simultaneously)
    if (stems['vocals']) {
        stems['vocals'].element.addEventListener('timeupdate', () => {
            if(!masterProgress.matches(':active')) {
                masterProgress.value = stems['vocals'].element.currentTime;
                timeCurrent.innerText = formatTime(stems['vocals'].element.currentTime);
            }
        });
    }
}

masterPlayBtn.addEventListener('click', () => {
    if (isPlaying) {
        Object.values(stems).forEach(s => s.element.pause());
        masterPlayBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    } else {
        const time = parseFloat(masterProgress.value) || 0;
        Object.values(stems).forEach(s => {
            s.element.currentTime = time; // enforce strict sync on play
            s.element.play().catch(e => console.error(`Play error on ${s.element.src}:`, e));
        });
        masterPlayBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    }
    isPlaying = !isPlaying;
});

// Update UI text ONLY while dragging
masterProgress.addEventListener('input', (e) => {
    const time = parseFloat(e.target.value);
    timeCurrent.innerText = formatTime(time);
});

// Actually seek audio when mouse is released
masterProgress.addEventListener('change', (e) => {
    const time = parseFloat(e.target.value);
    Object.values(stems).forEach(s => {
        s.element.currentTime = time;
    });
    // if it was playing, play might have been interrupted by buffering
    if (isPlaying) {
        Object.values(stems).forEach(s => s.element.play().catch(e=>console.error(e)));
    }
});

function updateStemVolume() {
    const anySolo = Object.values(stems).some(s => s.isSolo);
    Object.keys(stems).forEach(name => {
        const s = stems[name];
        let targetVolume = s.volume;
        
        if (anySolo) {
            targetVolume = s.isSolo ? s.volume : 0;
        } else if (s.isMuted) {
            targetVolume = 0;
        }
        
        // Update both the native audio element and the Web Audio Gain Node
        s.element.volume = targetVolume;
        if (s.gainNode) {
            s.gainNode.gain.value = targetVolume;
        }
    });
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}
