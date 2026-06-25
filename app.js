const setupSection = document.getElementById('setupSection');
const mainSection = document.getElementById('mainSection');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const resetKeyBtn = document.getElementById('resetKeyBtn');

const audioFileInput = document.getElementById('audioFile');
const uploadBtn = document.getElementById('uploadBtn');
const statusLabel = document.getElementById('statusLabel');
const outputText = document.getElementById('outputText');
const copyBtn = document.getElementById('copyBtn');

const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');

const CACHE_KEY = 'swaramCouncilorData';
const CACHE_TIME_KEY = 'swaramCouncilorDataTime';
const CACHE_DURATION_MS = 30 * 24 * 60 * 60 * 1000; 

window.onload = () => { 
    checkApiKey(); 
    updateCouncilorDataInBackground(); 
};

function checkApiKey() {
    const savedKey = localStorage.getItem('swaramApiKey');
    if (savedKey && (savedKey.startsWith("AQ.") || savedKey.startsWith("AIza"))) {
        setupSection.style.display = 'none';
        mainSection.style.display = 'block';
    } else {
        setupSection.style.display = 'block';
        mainSection.style.display = 'none';
    }
}

saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key.startsWith("AQ.") && !key.startsWith("AIza")) {
        alert("തെറ്റായ API Key! ഗൂഗിളിന്റെ കീ എപ്പോഴും 'AQ.' അല്ലെങ്കിൽ 'AIza' എന്നതിലാണ് തുടങ്ങുക.");
        return;
    }
    localStorage.setItem('swaramApiKey', key);
    apiKeyInput.value = ""; 
    checkApiKey();
});

resetKeyBtn.addEventListener('click', () => {
    if(confirm("നിലവിലുള്ള API Key മായ്ച്ചു കളയണമെന്നുറപ്പാണോ?")) {
        localStorage.removeItem('swaramApiKey');
        checkApiKey();
    }
});

async function updateCouncilorDataInBackground() {
    const cachedTime = localStorage.getItem(CACHE_TIME_KEY);
    const now = Date.now();

    if (!cachedTime || (now - parseInt(cachedTime)) > CACHE_DURATION_MS) {
        if (navigator.onLine) {
            console.log("Councilor data background update started...");
            try {
                const targetUrl = 'https://nilamburmunicipality.lsgkerala.gov.in/en/Elected%20representatives';
                const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
                
                const response = await fetch(proxyUrl);
                const data = await response.json();
                
                const parser = new DOMParser();
                const doc = parser.parseFromString(data.contents, 'text/html');
                
                let extractedText = "";
                const tables = doc.querySelectorAll('table');
                tables.forEach(table => {
                    extractedText += table.innerText + " \n";
                });

                if (extractedText.trim().length > 10) {
                    localStorage.setItem(CACHE_KEY, extractedText);
                    localStorage.setItem(CACHE_TIME_KEY, now.toString());
                    console.log("Councilor data saved successfully.");
                }
            } catch (error) {
                console.error("Background update failed:", error);
            }
        }
    }
}

const MAX_CHUNK_BYTES = 18 * 1024 * 1024; 

async function decodeAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return { audioBuffer, audioCtx };
}

const SILENCE_RMS_THRESHOLD = 0.015;      
const SILENCE_FRAME_MS = 50;              
const MAX_SILENCE_DURATION_SEC = 0.6;     
const MIN_SILENCE_RUN_MS = 300;           

function findSilenceFrames(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;
    const frameSize = Math.max(1, Math.floor(sampleRate * SILENCE_FRAME_MS / 1000));

    const monoData = new Float32Array(totalSamples);
    for (let ch = 0; ch < numChannels; ch++) {
        const chData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < totalSamples; i++) {
            monoData[i] += chData[i] / numChannels;
        }
    }

    const numFrames = Math.ceil(totalSamples / frameSize);
    const isSilentFrame = new Uint8Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
        const start = f * frameSize;
        const end = Math.min(start + frameSize, totalSamples);
        let sumSquares = 0;
        for (let i = start; i < end; i++) sumSquares += monoData[i] * monoData[i];
        const rms = Math.sqrt(sumSquares / (end - start));
        isSilentFrame[f] = rms < SILENCE_RMS_THRESHOLD ? 1 : 0;
    }

    return { isSilentFrame, frameSize, numFrames };
}

function trimSilence(audioBuffer, audioCtx) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;

    const { isSilentFrame, frameSize, numFrames } = findSilenceFrames(audioBuffer);
    const minSilentFrames = Math.ceil(MIN_SILENCE_RUN_MS / SILENCE_FRAME_MS);
    const maxKeepFrames = Math.ceil((MAX_SILENCE_DURATION_SEC * 1000) / SILENCE_FRAME_MS);

    const keepRanges = [];
    let i = 0;
    while (i < numFrames) {
        if (!isSilentFrame[i]) {
            let j = i;
            while (j < numFrames && !isSilentFrame[j]) j++;
            keepRanges.push([i * frameSize, Math.min(j * frameSize, totalSamples)]);
            i = j;
        } else {
            let j = i;
            while (j < numFrames && isSilentFrame[j]) j++;
            const runLength = j - i;
            if (runLength >= minSilentFrames) {
                const framesToKeep = Math.min(runLength, maxKeepFrames);
                keepRanges.push([i * frameSize, Math.min((i + framesToKeep) * frameSize, totalSamples)]);
            } else {
                keepRanges.push([i * frameSize, Math.min(j * frameSize, totalSamples)]);
            }
            i = j;
        }
    }

    let newLength = 0;
    for (const [s, e] of keepRanges) newLength += (e - s);

    if (newLength >= totalSamples || newLength === 0) return audioBuffer;

    const OfflineCtxCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const trimmedBuffer = new OfflineCtxCtor(numChannels, newLength, sampleRate).createBuffer(numChannels, newLength, sampleRate);

    for (let ch = 0; ch < numChannels; ch++) {
        const srcData = audioBuffer.getChannelData(ch);
        const dstData = trimmedBuffer.getChannelData(ch);
        let writeOffset = 0;
        for (const [s, e] of keepRanges) {
            dstData.set(srcData.subarray(s, e), writeOffset);
            writeOffset += (e - s);
        }
    }
    return trimmedBuffer;
}

function findNearestSilenceSplitPoint(silenceInfo, targetSample, searchWindowSamples, totalSamples) {
    const { isSilentFrame, frameSize, numFrames } = silenceInfo;
    const targetFrame = Math.round(targetSample / frameSize);
    const maxFrameOffset = Math.ceil(searchWindowSamples / frameSize);

    for (let offset = 0; offset <= maxFrameOffset; offset++) {
        const candidates = offset === 0 ? [targetFrame] : [targetFrame - offset, targetFrame + offset];
        for (const f of candidates) {
            if (f >= 0 && f < numFrames && isSilentFrame[f]) {
                const frameStart = f * frameSize;
                const frameEnd = Math.min(frameStart + frameSize, totalSamples);
                const center = Math.floor((frameStart + frameEnd) / 2);
                return Math.max(1, Math.min(center, totalSamples - 1));
            }
        }
    }
    return targetSample;
}

function pickRecorderMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const type of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return null; 
}

function renderAndEncodeChunk(audioBuffer, startSample, endSample, mimeType) {
    return new Promise((resolve, reject) => {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const frameCount = endSample - startSample;

        const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const offlineCtx = new OfflineCtx(numChannels, frameCount, sampleRate);

        const chunkBuffer = offlineCtx.createBuffer(numChannels, frameCount, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
            chunkBuffer.copyToChannel(audioBuffer.getChannelData(ch).subarray(startSample, endSample), ch);
        }

        const source = offlineCtx.createBufferSource();
        source.buffer = chunkBuffer;
        source.connect(offlineCtx.destination);
        source.start();

        offlineCtx.startRendering().then((renderedBuffer) => {
            const liveCtx = new (window.AudioContext || window.webkitAudioContext)();
            const dest = liveCtx.createMediaStreamDestination();
            const playSource = liveCtx.createBufferSource();
            playSource.buffer = renderedBuffer;
            playSource.connect(dest); 

            const recorder = new MediaRecorder(dest.stream, {
                ...(mimeType ? { mimeType } : {}),
                audioBitsPerSecond: 16000
            });
            const recordedChunks = [];

            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) recordedChunks.push(e.data);
            };
            recorder.onstop = () => {
                liveCtx.close();
                const blob = new Blob(recordedChunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
                resolve(blob);
            };
            recorder.onerror = (e) => {
                liveCtx.close();
                reject(e.error || new Error('Recording failed'));
            };

            recorder.start();
            playSource.start();
            playSource.onended = () => { setTimeout(() => recorder.stop(), 100); };
        }).catch(reject);
    });
}

function audioBufferSliceToWavBlob(audioBuffer, startSample, endSample) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const frameCount = endSample - startSample;

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channelData.push(audioBuffer.getChannelData(ch).subarray(startSample, endSample));
    }

    const bytesPerSample = 2; 
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = frameCount * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < frameCount; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            let sample = channelData[ch][i];
            sample = Math.max(-1, Math.min(1, sample));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

async function splitAudioBufferIntoChunks(audioBuffer, onProgress) {
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;
    const mimeType = pickRecorderMimeType();

    const silenceInfo = findSilenceFrames(audioBuffer);
    const SPLIT_SEARCH_WINDOW_SEC = 12; 

    function nextSplitPoint(targetSample) {
        if (targetSample >= totalSamples) return totalSamples;
        return findNearestSilenceSplitPoint(
            silenceInfo, targetSample, SPLIT_SEARCH_WINDOW_SEC * sampleRate, totalSamples
        );
    }

    let chunks = [];

    if (mimeType) {
        const bytesPerSecEstimate = 2000;
        const secondsPerChunk = Math.max(15, Math.floor((MAX_CHUNK_BYTES * 0.7) / bytesPerSecEstimate));
        const samplesPerChunk = Math.floor(secondsPerChunk * sampleRate);

        const totalChunksEstimate = Math.max(1, Math.ceil(totalSamples / samplesPerChunk));
        let chunkIndex = 0;

        let start = 0;
        while (start < totalSamples) {
            const targetEnd = start + samplesPerChunk;
            const end = nextSplitPoint(targetEnd);

            chunkIndex++;
            if (onProgress) onProgress(chunkIndex, totalChunksEstimate);

            let blob = await renderAndEncodeChunk(audioBuffer, start, end, mimeType);

            if (blob.size > MAX_CHUNK_BYTES && (end - start) > sampleRate * 5) {
                const midTarget = start + Math.floor((end - start) / 2);
                const mid = nextSplitPoint(midTarget);
                const safeMid = (mid > start && mid < end) ? mid : midTarget; 

                const firstHalf = await renderAndEncodeChunk(audioBuffer, start, safeMid, mimeType);
                const secondHalf = await renderAndEncodeChunk(audioBuffer, safeMid, end, mimeType);
                chunks.push({ blob: firstHalf, startTime: start / sampleRate, endTime: safeMid / sampleRate, mimeType });
                chunks.push({ blob: secondHalf, startTime: safeMid / sampleRate, endTime: end / sampleRate, mimeType });
            } else {
                chunks.push({ blob, startTime: start / sampleRate, endTime: end / sampleRate, mimeType });
            }
            start = end;
        }
    } else {
        const numChannels = audioBuffer.numberOfChannels;
        const bytesPerSample = 2 * numChannels;
        const samplesPerChunk = Math.floor((MAX_CHUNK_BYTES * 0.9) / bytesPerSample);

        let start = 0;
        while (start < totalSamples) {
            const targetEnd = start + samplesPerChunk;
            const end = nextSplitPoint(targetEnd);
            const blob = audioBufferSliceToWavBlob(audioBuffer, start, end);
            chunks.push({ blob, startTime: start / sampleRate, endTime: end / sampleRate, mimeType: 'audio/wav' });
            start = end;
        }
    }
    return chunks;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
    });
}

uploadBtn.addEventListener('click', async () => {
    const apiKey = localStorage.getItem('swaramApiKey');
    const file = audioFileInput.files[0];

    if (!file) {
        alert("ദയവായി പ്രോസസ്സ് ചെയ്യേണ്ട ഓഡിയോ/വീഡിയോ ഫയൽ തിരഞ്ഞെടുക്കുക!"); return;
    }

    progressContainer.style.display = 'none';
    progressFill.style.width = '0%';
    progressFill.innerText = '0%';
    progressFill.className = ''; 

    uploadBtn.disabled = true;
    outputText.value = "";
    statusLabel.classList.add('pulse-text');

    let liveCouncilorData = localStorage.getItem(CACHE_KEY);

    const PRIMARY_MODEL = "gemini-2.5-flash";
    const FALLBACK_MODEL = "gemini-2.5-pro"; 

    function buildPromptText(extraTimeContext) {
        let promptText = `Act as a professional Municipality Council Secretary for Nilambur Municipality (നിലമ്പൂർ മുൻസിപ്പാലിറ്റി), Kerala. Listen to this Malayalam council meeting recording. 

[CONTEXT FOR SPEAKER IDENTIFICATION]: 
The current leadership includes Chairperson Padmini Gopinath, Vice Chairperson Shoukkathali Koomanchery, and Secretary Ferose Khan. The council consists of 33 ward members including Gireesh Moloormadathil, Aruma P T, Bushra Muneeb, Mumthas, Sameera K P, Velukutty N, Hamza P V, Musthafa K, Asrath, P M Basheer, Kunhimuhammed, Suresh P, Sreeja, Thongodan Sundaran, Sherly Mol, E S Mujeeb, Paloly Mehaboob, Geetha, Adukkath Ishak, Naicy, Gopinathan, Noorjahan P, Subaida Thattarasseri, Gopalakrishnan P, Unnikrishnan, Shareefa, Daisy Chacko, Mujeeb Devasseri, Sindhu, Sumeera P, Radha P, Binu.

[TASKS]:
1. Transcribe the discussion clearly in Malayalam.
2. Fix all grammatical and speech errors to make it an official document.
3. Identify different speakers accurately by matching their names from the current council list when someone is addressed. Use formats like "ചെയർപേഴ്സൺ പത്മിനി ഗോപിനാഥ്:" or "സെക്രട്ടറി ഫിറോസ് ഖാൻ:".
4. Provide a clear, bulleted summary of the Key Decisions taken at the end.`;

        if (liveCouncilorData) {
            promptText += `\n\n[LIVE COUNCILOR DATA SCRAPED FROM WEBSITE]:\nHere is the latest raw text data from the municipality website containing the names of current elected representatives. Use this data to accurately identify and format the names of the speakers in the transcript:\n\n${liveCouncilorData}`;
        }

        if (extraTimeContext) {
            promptText += `\n\n${extraTimeContext}`;
        }

        return promptText;
    }

    async function callGemini(modelName, promptText, base64Audio, mimeType) {
        return new Promise((resolve, reject) => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');

            progressContainer.style.display = 'block';
            progressFill.style.width = '0%';
            progressFill.innerText = '0%';
            progressFill.className = 'bg-uploading'; // ഗൂഗിളിലേക്ക് പോകുമ്പോൾ പച്ച നിറം

            xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = percentComplete + '%';
                    progressFill.innerText = percentComplete + '% അപ്‌ലോഡ് ചെയ്തു...';
                    
                    if(percentComplete === 100) {
                        progressFill.innerText = 'AI വിശകലനം ചെയ്യുന്നു... കാത്തിരിക്കുക';
                    }
                }
            };

            xhr.onload = function() {
                progressContainer.style.display = 'none';
                progressFill.style.width = '0%'; 
                
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch(err) {
                        resolve({ error: { message: `HTTP Error ${xhr.status}`, code: xhr.status } });
                    }
                }
            };

            xhr.onerror = function() {
                progressContainer.style.display = 'none';
                resolve({ error: { message: "Network Error: അപ്‌ലോഡിംഗ് പരാജയപ്പെട്ടു." } });
            };

            const body = JSON.stringify({
                contents: [{
                    parts: [
                        { text: promptText },
                        { inlineData: { mimeType: mimeType, data: base64Audio } }
                    ]
                }]
            });
            
            xhr.send(body);
        });
    }

    function isModelMissingError(data) {
        return data.error && (
            data.error.code === 404 ||
            (data.error.message && data.error.message.toLowerCase().includes("not found")) ||
            (data.error.message && data.error.message.toLowerCase().includes("not supported"))
        );
    }

    async function transcribeChunk(base64Audio, mimeType, promptText) {
        let data = await callGemini(PRIMARY_MODEL, promptText, base64Audio, mimeType);

        if (isModelMissingError(data)) {
            data = await callGemini(FALLBACK_MODEL, promptText, base64Audio, mimeType);
        }

        if (data.error) {
            return { error: data.error };
        }
        if (data.candidates && data.candidates[0].content.parts[0].text) {
            return { text: data.candidates[0].content.parts[0].text };
        }
        return { error: { message: "മറുപടി ലഭിക്കുന്നതിൽ തകരാർ സംഭവിച്ചു." } };
    }

    function showApiError(err) {
        console.error("API Error:", err);
        statusLabel.classList.remove('pulse-text');
        if (err.code === 429) {
            statusLabel.innerText = "Error 429: ഇപ്പോൾ ഉപയോഗം കൂടുതലാണ് (Rate Limit). കുറച്ച് സമയത്തിന് ശേഷം വീണ്ടും ശ്രമിക്കുക.";
        } else if (err.code === 400 || err.status === "INVALID_ARGUMENT" || err.code === 401) {
            statusLabel.innerText = "API Key തകരാർ: താങ്കൾ നൽകിയ കീ പ്രവർത്തിക്കുന്നില്ല. പുതിയ കീ നൽകുക.";
            localStorage.removeItem('swaramApiKey');
            checkApiKey();
        } else {
            statusLabel.innerText = `Error: ${err.message}`;
        }
        statusLabel.style.color = "var(--error-color)";
    }

    try {
        statusLabel.innerText = "ഫയൽ വായിക്കുന്നു...";
        statusLabel.style.color = "var(--warning-color)";

        const { audioBuffer, audioCtx } = await decodeAudioFile(file);

        statusLabel.innerText = "നിശബ്ദമായ ഭാഗങ്ങൾ കുറുക്കുന്നു...";
        const trimmedBuffer = trimSilence(audioBuffer, audioCtx);

        // കൺവെർഷൻ തുടങ്ങുമ്പോൾ പ്രോഗ്രസ് ബാർ കാണിക്കുന്നു (ഓറഞ്ച് നിറത്തിൽ)
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressFill.className = 'bg-converting';
        progressFill.innerText = '0% കൺവെർട്ട് ചെയ്തു...';

        const chunks = await splitAudioBufferIntoChunks(trimmedBuffer, (done, total) => {
            const percentComplete = Math.round((done / total) * 100);
            progressFill.style.width = percentComplete + '%';
            progressFill.innerText = percentComplete + '% കൺവെർട്ട് ചെയ്തു...';
            statusLabel.innerText = `ഓഡിയോ WebM രൂപത്തിലേക്ക് മാറ്റുന്നു... (${done} / ${total})`;
        });

        audioCtx.close();
        progressFill.style.width = '0%';
        progressContainer.style.display = 'none';

        const collectedTexts = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunks.length > 1) {
                statusLabel.innerText = `ഭാഗം ${i + 1} / ${chunks.length} അപ്‌ലോഡ് ചെയ്യുന്നു...`;
            } else {
                statusLabel.innerText = `ഫയൽ അപ്‌ലോഡ് ചെയ്യുന്നു...`;
            }
            statusLabel.style.color = "var(--secondary-color)";

            const base64Audio = await blobToBase64(chunk.blob);
            const mimeType = chunk.mimeType || "audio/webm";

            const timeContext = chunks.length > 1 
                ? `[NOTE]: This is part ${i + 1} of ${chunks.length} of a longer meeting recording. Transcribe only what is heard in this segment. Do not repeat instructions or add a combined summary.` 
                : null;
                
            const promptText = buildPromptText(timeContext);

            const result = await transcribeChunk(base64Audio, mimeType, promptText);

            if (result.error) {
                showApiError(result.error);
                outputText.value = collectedTexts.join("\n\n");
                uploadBtn.disabled = false;
                return;
            }

            if (chunks.length > 1) {
                collectedTexts.push(`--- ഭാഗം ${i + 1} ---\n${result.text}`);
            } else {
                collectedTexts.push(result.text);
            }
            
            outputText.value = collectedTexts.join("\n\n");
        }

        statusLabel.classList.remove('pulse-text');
        statusLabel.innerText = `റിപ്പോർട്ട് തയ്യാറാണ് ✨`;
        statusLabel.style.color = "var(--primary-color)";

    } catch (err) {
        console.error(err);
        statusLabel.classList.remove('pulse-text');
        statusLabel.innerText = "തകരാർ! ഫയൽ പ്രോസസ്സ് ചെയ്യാൻ സാധിച്ചില്ല.";
        statusLabel.style.color = "var(--error-color)";
    }

    uploadBtn.disabled = false;
});

copyBtn.addEventListener('click', () => {
    if (!outputText.value) {
        alert("കോപ്പി ചെയ്യാൻ വിവരങ്ങളില്ല!"); return;
    }
    navigator.clipboard.writeText(outputText.value).then(() => {
        alert("റിപ്പോർട്ട് പൂർണ്ണമായും കോപ്പിയായി! ഇത് നേരിട്ട് ഉപയോഗിക്കാം.");
    });
});