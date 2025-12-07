import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Square, Mic, Music, FileText, Download, Volume2, RefreshCcw, AlertCircle, X, Check, Trash2 } from 'lucide-react';

// --- 1. AudioWorklet 处理器代码 (作为字符串嵌入，运行在独立音频线程) ---
const recorderWorkletCode = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096; // 缓冲区大小
    this._buffer = new Float32Array(this._bufferSize);
    this._bytesWritten = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      // 如果是双声道输入
      if (input.length >= 2) {
          const left = input[0];
          const right = input[1];
          for (let i = 0; i < left.length; i++) {
              this._buffer[this._bytesWritten++] = left[i];
              this._buffer[this._bytesWritten++] = right[i];
              
              // 缓冲区满，发送回主线程
              if (this._bytesWritten >= this._bufferSize) {
                  this.port.postMessage(this._buffer.slice(0, this._bufferSize));
                  this._bytesWritten = 0;
              }
          }
      } else {
          // 单声道输入
          const channel = input[0];
          for (let i = 0; i < channel.length; i++) {
              this._buffer[this._bytesWritten++] = channel[i];
              
              if (this._bytesWritten >= this._bufferSize) {
                  this.port.postMessage(this._buffer.slice(0, this._bufferSize));
                  this._bytesWritten = 0;
              }
          }
      }
    }
    return true; // 保持处理器活跃
  }
}
registerProcessor('recorder-worklet', RecorderProcessor);
`;

// --- 2. WAV 编码工具函数 (支持 16bit PCM / 32bit Float) ---
const writeString = (view, offset, string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

const floatTo16BitPCM = (output, offset, input) => {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
};

const writeFloat32 = (output, offset, input) => {
  for (let i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
};

const interleave = (inputL, inputR) => {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    while (index < length) {
        result[index++] = inputL[inputIndex];
        result[index++] = inputR[inputIndex];
        inputIndex++;
    }
    return result;
};

const encodeWAV = (samples, sampleRate, numChannels = 1, bitDepth = 32) => {
  const bytesPerSample = bitDepth / 8;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  // 写 WAV 头信息
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  
  const format = bitDepth === 32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM
  view.setUint16(20, format, true); 
  
  view.setUint16(22, numChannels, true); // 通道数
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // 字节率
  view.setUint16(32, numChannels * bytesPerSample, true); // 块对齐
  view.setUint16(34, bitDepth, true); // 位深度
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  // 写入 数据
  if (bitDepth === 32) {
      writeFloat32(view, 44, samples);
  } else {
      floatTo16BitPCM(view, 44, samples);
  }

  return new Blob([view], { type: 'audio/wav' });
};

const bufferToWav = (audioBuffer) => {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    
    let interleaved;
    if (numChannels === 2) {
        const left = audioBuffer.getChannelData(0);
        const right = audioBuffer.getChannelData(1);
        interleaved = interleave(left, right);
    } else {
        interleaved = audioBuffer.getChannelData(0);
    }
    
    return encodeWAV(interleaved, sampleRate, numChannels, 32);
};

// --- 3. 增强版 LRC 解析器 (支持逐字时间戳) ---
const parseTimeTag = (timeStr) => {
  const match = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/.exec(timeStr);
  if (!match) return null;
  const minutes = parseInt(match[1]);
  const seconds = parseInt(match[2]);
  const milliseconds = parseInt(match[3].padEnd(3, '0')); 
  return minutes * 60 + seconds + milliseconds / 1000;
};

const parseLrc = (lrcString) => {
  const lines = lrcString.split('\n');
  const result = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // 分割时间标签和文本
    const parts = trimmed.split(/(\[\d{2}:\d{2}\.\d{2,3}\])/).filter(p => p.trim() !== '');
    if (parts.length === 0) continue;

    const firstTime = parseTimeTag(parts[0]);
    if (firstTime === null) continue; 

    const rawWords = [];
    let currentWordTime = firstTime;
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith('[')) {
            const t = parseTimeTag(part);
            if (t !== null) currentWordTime = t;
        } else {
            rawWords.push({ time: currentWordTime, text: part });
        }
    }

    // 计算每个字的持续时间 (Duration)
    const processedWords = rawWords.map((word, index) => {
        let duration = 0;
        if (index < rawWords.length - 1) {
            duration = rawWords[index + 1].time - word.time;
        } else {
            duration = 0.5; // 行末默认缓冲
        }
        if (duration < 0.1) duration = 0.1; // 最小持续时间保护
        return { ...word, duration };
    });

    if (processedWords.length > 0) {
        const fullText = processedWords.map(w => w.text).join('');
        const lineStartTime = processedWords[0].time;

        result.push({
            time: lineStartTime,
            text: fullText,
            words: processedWords
        });
    }
  }
  return result.sort((a, b) => a.time - b.time);
};

// --- 3.5 SRT 解析器 ---
const parseSrtTime = (timeStr) => {
  const parts = timeStr.replace(',', '.').split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
  } else if (parts.length === 2) {
      const [m, s] = parts;
      return parseFloat(m) * 60 + parseFloat(s);
  }
  return 0;
};

const parseSrt = (srtString) => {
  // 统一换行符并分割块
  const blocks = srtString.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const result = [];
  
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) continue;

    // 查找时间行 (包含 --> 的行)
    let timeLineIndex = lines.findIndex(l => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
    
    const startTime = parseSrtTime(startStr);
    const endTime = parseSrtTime(endStr);
    
    if (isNaN(startTime) || isNaN(endTime)) continue;
    
    const duration = endTime - startTime;

    // 提取文本 (时间行之后的所有内容)
    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join(' ');
    
    if (!text) continue;

    // 智能切分单词以实现平滑动画 (SRT 模拟 Karaoke 效果)
    // 根据字符长度分配时长
    const rawWords = text.split(/\s+/);
    const totalChars = text.replace(/\s/g, '').length;
    let currentTime = startTime;
    
    const words = rawWords.map(word => {
        const wordClean = word.replace(/\s/g, '');
        const weight = wordClean.length / totalChars;
        const wordDuration = duration * weight;
        
        const wordObj = {
            time: currentTime,
            text: word + ' ', // 保留间距
            duration: wordDuration
        };
        
        currentTime += wordDuration;
        return wordObj;
    });

    result.push({
        time: startTime,
        text: text,
        words: words
    });
  }
  return result.sort((a, b) => a.time - b.time);
};

// --- 3.8 ASS 解析器 ---
const parseAssTime = (timeStr) => {
    // 0:00:05.10 => 5.1
    const parts = timeStr.trim().split(':');
    if (parts.length === 3) {
        const [h, m, s] = parts;
        return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
    }
    return 0;
};

const parseAss = (assContent) => {
    const lines = assContent.split('\n');
    const result = [];
    let format = []; // 存储 Format 字段顺序

    // 查找 [Events] 区域
    let inEvents = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed === '[Events]') {
            inEvents = true;
            continue;
        }

        if (!inEvents) continue;

        // 解析 Format 行
        if (trimmed.startsWith('Format:')) {
            // Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
            const formatStr = trimmed.substring(7).trim();
            format = formatStr.split(',').map(f => f.trim().toLowerCase());
            continue;
        }

        // 解析 Dialogue 行
        if (trimmed.startsWith('Dialogue:')) {
            if (format.length === 0) continue; // 没找到 Format 定义，跳过

            // Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Singing this song
            // 注意：Text 内容可能包含逗号，所以前几个字段按逗号分割，最后一个 Text 字段保留剩余部分
            const prefix = trimmed.substring(9).trim();
            
            // 找到第 format.length - 1 个逗号的位置，分割成 metadata 和 text
            let commaCount = 0;
            let splitIndex = -1;
            for(let i=0; i<prefix.length; i++) {
                if(prefix[i] === ',') {
                    commaCount++;
                    if(commaCount === format.length - 1) {
                        splitIndex = i;
                        break;
                    }
                }
            }
            
            if (splitIndex === -1) continue;

            const metaStr = prefix.substring(0, splitIndex);
            const textContent = prefix.substring(splitIndex + 1);
            const metaParts = metaStr.split(',');

            const startIndex = format.indexOf('start');
            const endIndex = format.indexOf('end');
            
            if (startIndex === -1 || endIndex === -1) continue;

            const startTime = parseAssTime(metaParts[startIndex]);
            const endTime = parseAssTime(metaParts[endIndex]);
            const duration = endTime - startTime;

            // 清理 ASS 标签 {\...}
            const cleanText = textContent.replace(/\{.*?\}/g, '').trim();
            if (!cleanText) continue;

            // 智能切分 (同 SRT)
            const rawWords = cleanText.split(/\s+/);
            const totalChars = cleanText.replace(/\s/g, '').length;
            let currentTime = startTime;
            
            const words = rawWords.map(word => {
                const wordClean = word.replace(/\s/g, '');
                const weight = wordClean.length / totalChars;
                const wordDuration = duration * weight;
                
                const wordObj = {
                    time: currentTime,
                    text: word + ' ',
                    duration: wordDuration
                };
                
                currentTime += wordDuration;
                return wordObj;
            });

            result.push({
                time: startTime,
                text: cleanText,
                words: words
            });
        }
    }
    return result.sort((a, b) => a.time - b.time);
};

// --- 4. React 主组件 ---
export default function App() {
  // 核心状态
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [lyrics, setLyrics] = useState([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  
  // 资源状态
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [lyricFileName, setLyricFileName] = useState("");
  
  // 录音状态
  const [isRecording, setIsRecording] = useState(false);
  const [recordingBlob, setRecordingBlob] = useState(null);
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [micPermission, setMicPermission] = useState(false);

  // 设置与反馈
  const [monitorMic, setMonitorMic] = useState(false); 
  const [toastMessage, setToastMessage] = useState(null); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [latencyOffset, setLatencyOffset] = useState(() => {
    // 从 localStorage 读取保存的延迟补偿值
    const saved = localStorage.getItem('puresing_latencyOffset');
    return saved ? parseInt(saved, 10) : 0;
  }); // 手动延迟补偿 (ms)
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [vocalVolume, setVocalVolume] = useState(1.0);
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  
  // Refs
  const audioRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamSourceRef = useRef(null); 
  const workletNodeRef = useRef(null); 
  const monitorGainNodeRef = useRef(null); 
  const audioChunksRef = useRef([]);
  const backingBufferRef = useRef(null); // 存储解码后的伴奏数据
  const previewSourceRef = useRef(null); // 存储预览时的 Source 节点 (可能包含多个)
  const previewGainRef = useRef(null);   // 存储预览时的 Gain 节点
  const previewStartTimeRef = useRef(0);
  const previewStartOffsetRef = useRef(0);
  const previewRafRef = useRef(null);
  const recordingChannelsRef = useRef(1);
  
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lyricsFrameRef = useRef(null);
  const toastTimeoutRef = useRef(null);

  const showToast = (msg) => {
    setToastMessage(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 3000);
  };

  // 初始化 AudioContext
  useEffect(() => {
    const initAudio = async () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext({ sampleRate: 44100 }); 
        audioContextRef.current = ctx;

        // 加载 AudioWorklet
        const blob = new Blob([recorderWorkletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);
        console.log("AudioWorklet module loaded");

      } catch (e) {
        console.error("Web Audio API setup failed:", e);
        showToast("音频引擎初始化失败，请使用最新版 Chrome/Edge");
      }
    };
    initAudio();
    
    // 获取麦克风权限
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(() => setMicPermission(true))
      .catch((err) => {
        console.error("Mic access denied:", err);
        setMicPermission(false);
        showToast("无法访问麦克风，请检查权限设置");
      });

    return () => {
      if (audioContextRef.current) audioContextRef.current.close();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (lyricsFrameRef.current) cancelAnimationFrame(lyricsFrameRef.current);
    };
  }, []);

  // 动态耳返控制
  useEffect(() => {
    if (monitorGainNodeRef.current && audioContextRef.current) {
        const gainNode = monitorGainNodeRef.current;
        const now = audioContextRef.current.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setTargetAtTime(monitorMic ? 0.8 : 0, now, 0.1);
    }
  }, [monitorMic]);

  // 高频渲染循环 (60FPS)
  const renderLoop = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      const now = audioRef.current.currentTime;
      setCurrentTime(now);
      lyricsFrameRef.current = requestAnimationFrame(renderLoop);
    }
  }, []);

  useEffect(() => {
    if (isPlaying) {
      lyricsFrameRef.current = requestAnimationFrame(renderLoop);
    } else {
      if (lyricsFrameRef.current) cancelAnimationFrame(lyricsFrameRef.current);
    }
    return () => {
      if (lyricsFrameRef.current) cancelAnimationFrame(lyricsFrameRef.current);
    };
  }, [isPlaying, renderLoop]);

  // 同步当前行
  useEffect(() => {
    const index = lyrics.findIndex((line, i) => {
      const nextLine = lyrics[i + 1];
      return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
    if (index !== -1 && index !== currentLineIndex) {
      setCurrentLineIndex(index);
    }
  }, [currentTime, lyrics, currentLineIndex]);


  const handleAudioUpload = async (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setAudioFile(file);
      setAudioUrl(url);
      setIsPlaying(false);
      setCurrentTime(0);
      setRecordingBlob(null);
      setRecordingUrl(null);
      showToast("正在解码伴奏...");

      // 解码伴奏数据用于后续混合
      try {
          const arrayBuffer = await file.arrayBuffer();
          // 注意：需要使用一个新的 AudioContext 或者当前的（如果已初始化）来解码
          // 建议始终使用 audioContextRef.current，如果未初始化则临时创建
          let ctx = audioContextRef.current;
          if (!ctx) {
              const AudioContext = window.AudioContext || window.webkitAudioContext;
              ctx = new AudioContext();
              audioContextRef.current = ctx;
          }
          const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
          backingBufferRef.current = decodedBuffer;
          showToast("伴奏加载并解码完成");
      } catch (error) {
          console.error("解码伴奏失败", error);
          showToast("伴奏解码失败，可能无法导出混合音频");
      }
    }
  };

  const handleLyricUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setLyricFileName(file.name);
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        let parsed = [];
        
        const lowerName = file.name.toLowerCase();
        if (lowerName.endsWith('.srt')) {
             parsed = parseSrt(text);
        } else if (lowerName.endsWith('.ass')) {
             parsed = parseAss(text);
        } else {
             parsed = parseLrc(text);
        }

        setLyrics(parsed);
        showToast("歌词已加载");
      };
      reader.readAsText(file);
    }
  };

  const togglePlay = async () => {
    if (!audioUrl) {
        showToast("请先在左侧导入伴奏文件！");
        return;
    }

    const audio = audioRef.current;
    
    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    if (isPlaying) {
      audio.pause();
      stopRecording();
      setIsPlaying(false);
    } else {
      // 先启动录音，确保没有启动延迟导致的人声“抢跑”
      const success = await startRecording();
      if (success) {
          try {
            await audio.play();
            setIsPlaying(true);
          } catch (err) {
            console.error("Play failed:", err);
            stopRecording(); // 如果播放失败，停止录音
            showToast("播放失败");
          }
      }
    }
  };

  const startRecording = async () => {
    if (!micPermission) {
        showToast("麦克风未授权，无法录音");
        return false;
    }
    
    try {
      const ctx = audioContextRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 44100,
          echoCancellation: false, 
          noiseSuppression: false, 
          autoGainControl: false,  
          channelCount: 2
        } 
      });

      // 检测实际声道数
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      // 有些浏览器可能不返回 channelCount，默认回退到 1 或 2，取决于实际情况
      // 但 getUserMedia 成功意味着它尽可能满足了请求。
      if (settings.channelCount) {
          recordingChannelsRef.current = settings.channelCount;
      } else {
          recordingChannelsRef.current = 2; // 如果请求了2，假设是2
      }
      console.log("Recording channels:", recordingChannelsRef.current);

      const source = ctx.createMediaStreamSource(stream);
      mediaStreamSourceRef.current = source;

      // 使用 Worklet
      const workletNode = new AudioWorkletNode(ctx, 'recorder-worklet');
      workletNodeRef.current = workletNode;
      audioChunksRef.current = [];

      workletNode.port.onmessage = (e) => {
        audioChunksRef.current.push(new Float32Array(e.data));
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination); 

      // 耳返路径
      const monitorGain = ctx.createGain();
      monitorGain.gain.value = monitorMic ? 0.8 : 0; 
      monitorGainNodeRef.current = monitorGain;
      
      source.connect(monitorGain);
      monitorGain.connect(ctx.destination);

      setupVisualizer(source);
      setIsRecording(true);
      return true;

    } catch (err) {
      console.error("Error starting recording:", err);
      showToast("录音启动失败");
      return false;
    }
  };

  const stopRecording = () => {
    if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
        workletNodeRef.current.port.onmessage = null; 
    }
    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
    }
    if (monitorGainNodeRef.current) {
        monitorGainNodeRef.current.disconnect();
        monitorGainNodeRef.current = null;
    }
    
    setIsRecording(false);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

    setTimeout(() => {
        if (audioChunksRef.current.length > 0) {
            processRecording();
        }
    }, 100);
  };

  const processRecording = () => {
    const chunks = audioChunksRef.current;
    if (chunks.length === 0) return;

    let totalLength = 0;
    for (let i = 0; i < chunks.length; i++) {
        totalLength += chunks[i].length;
    }

    const result = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        result.set(chunks[i], offset);
        offset += chunks[i].length;
    }

    // 导出干声 WAV (使用实际声道数, 32bit Float)
    const channels = recordingChannelsRef.current;
    const wavBlob = encodeWAV(result, audioContextRef.current.sampleRate, channels, 32);
    setRecordingBlob(wavBlob);
    const url = URL.createObjectURL(wavBlob);
    setRecordingUrl(url);
    
    // 计算预览时长：取伴奏和录音时长的最大值
    const recordingDuration = totalLength / audioContextRef.current.sampleRate;
    const backingDuration = backingBufferRef.current ? backingBufferRef.current.duration : 0;
    setPreviewDuration(Math.max(recordingDuration, backingDuration));
    setPreviewCurrentTime(0);

    setShowPreviewModal(true);
    showToast(`录音完成 (采样率 ${audioContextRef.current.sampleRate}Hz)`);
  };

  const createVocalBuffer = (ctx) => {
      const chunks = audioChunksRef.current;
      if (chunks.length === 0) return null;
 
      let totalLength = 0;
      for (let i = 0; i < chunks.length; i++) totalLength += chunks[i].length;
      const vocalFloat32 = new Float32Array(totalLength);
      let offset = 0;
      for (let i = 0; i < chunks.length; i++) {
          vocalFloat32.set(chunks[i], offset);
          offset += chunks[i].length;
      }
 
      // 使用 recordingChannelsRef.current 来决定 buffer 的通道数
      const channels = recordingChannelsRef.current;
      // 注意：createBuffer 的采样率必须与 ctx 一致，或者我们需要重采样
      // 这里假设 ctx (无论是 Offline 还是 Realtime) 都是当前环境的采样率，或者我们希望以当前采样率创建
      const vocalBuffer = ctx.createBuffer(channels, vocalFloat32.length / channels, audioContextRef.current.sampleRate);
      
      if (channels === 2) {
          const left = vocalBuffer.getChannelData(0);
          const right = vocalBuffer.getChannelData(1);
          for (let i = 0; i < vocalFloat32.length; i += 2) {
              left[i / 2] = vocalFloat32[i];
              right[i / 2] = vocalFloat32[i + 1];
          }
      } else {
          vocalBuffer.copyToChannel(vocalFloat32, 0);
      }
      return vocalBuffer;
  };

  const getCombinedAudioBuffer = async (volume = 1.0) => {
     if (!backingBufferRef.current || audioChunksRef.current.length === 0) return null;
     
     const backingBuffer = backingBufferRef.current;
     const sampleRate = backingBuffer.sampleRate; 
     const length = backingBuffer.length;
     
     // 2. 创建 OfflineAudioContext
     const offlineCtx = new OfflineAudioContext(backingBuffer.numberOfChannels, length, sampleRate);

     // 3. 设置伴奏源
     const backingSource = offlineCtx.createBufferSource();
     backingSource.buffer = backingBuffer;
     backingSource.connect(offlineCtx.destination);
     backingSource.start(0);

     // 4. 设置人声源
     const vocalBuffer = createVocalBuffer(offlineCtx);
     if (!vocalBuffer) return null;

     const vocalSource = offlineCtx.createBufferSource();
     vocalSource.buffer = vocalBuffer;
     
     // 应用音量
     const vocalGain = offlineCtx.createGain();
     vocalGain.gain.value = volume;
     vocalSource.connect(vocalGain);
     vocalGain.connect(offlineCtx.destination);
     
     // 应用延迟补偿
     const offsetSeconds = latencyOffset / 1000;
     let startTime = 0;
     let offsetStart = 0;

     if (offsetSeconds > 0) {
         startTime = offsetSeconds;
     } else {
         offsetStart = -offsetSeconds;
     }

     vocalSource.start(startTime, offsetStart);

     // 5. 渲染
     const renderedBuffer = await offlineCtx.startRendering();
     return renderedBuffer;
  };

  const handleExportMix = async () => {
    if (!recordingUrl || !backingBufferRef.current) {
        showToast("无录音或伴奏数据");
        return;
    }
    
    setIsProcessing(true);
    try {
        const renderedBuffer = await getCombinedAudioBuffer(vocalVolume);
        if (renderedBuffer) {
            const wavBlob = bufferToWav(renderedBuffer);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(wavBlob);
            const date = new Date().toISOString().slice(0, 10);
            a.download = `PureSing_Mix_${date}.wav`; 
            a.click();
            showToast("混合音频导出成功！");
        }
    } catch (e) {
        console.error("Export mix failed:", e);
        showToast("导出失败");
    } finally {
        setIsProcessing(false);
    }
  };

  // 跳过尾奏并完成
  const handleSkipAndFinish = () => {
      if (isPlaying) {
          // 1. 暂停播放
          audioRef.current.pause();
          
          // 2. 停止录音 (这会触发 processRecording 生成干声)
          stopRecording();
          setIsPlaying(false);
          
          showToast("已跳过尾奏，生成完整作品中...");
          // 此时 audioChunksRef 已经包含截至目前的数据
          // 稍后用户点击导出混合时，getCombinedAudioBuffer 会使用完整的 backingBuffer
          // 和截断的 vocalBuffer，实现“跳过尾奏但保留完整伴奏”的效果。
      }
  };

  // --- 预览功能 ---
  const stopPreview = () => {
    if (previewSourceRef.current) {
      // 停止所有源
      if (previewSourceRef.current.backing) {
          try { previewSourceRef.current.backing.stop(); } catch(e){}
          previewSourceRef.current.backing.disconnect();
      }
      if (previewSourceRef.current.vocal) {
          try { previewSourceRef.current.vocal.stop(); } catch(e){}
          previewSourceRef.current.vocal.disconnect();
      }
      previewSourceRef.current = null;
    }
    if (previewGainRef.current) {
        previewGainRef.current.disconnect();
        previewGainRef.current = null;
    }
    if (previewRafRef.current) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
    }
    setIsPreviewPlaying(false);
  };

  const updatePreviewProgress = useCallback(() => {
     if (!isPreviewPlaying) return;
     
     const ctx = audioContextRef.current;
     if (!ctx) return;

     const elapsed = ctx.currentTime - previewStartTimeRef.current;
     const current = previewStartOffsetRef.current + elapsed;

     if (current >= previewDuration) {
         setPreviewCurrentTime(previewDuration);
         stopPreview();
         setPreviewCurrentTime(0); // 播放结束复位
     } else {
         setPreviewCurrentTime(current);
         previewRafRef.current = requestAnimationFrame(updatePreviewProgress);
     }
  }, [isPreviewPlaying, previewDuration]);

  // 监听 isPreviewPlaying 变化来启动/停止 RAF
  useEffect(() => {
     if (isPreviewPlaying) {
         previewRafRef.current = requestAnimationFrame(updatePreviewProgress);
     } else {
         if (previewRafRef.current) {
             cancelAnimationFrame(previewRafRef.current);
         }
     }
  }, [isPreviewPlaying, updatePreviewProgress]);

  const playPreview = async () => {
    if (isPreviewPlaying) {
        stopPreview();
        return;
    }

    try {
        const ctx = audioContextRef.current;
        if (ctx.state === 'suspended') await ctx.resume();

        // 1. 准备人声源
        let vocalBuffer = null;
        if (audioChunksRef.current.length > 0) {
             vocalBuffer = createVocalBuffer(ctx);
        } else if (recordingUrl) {
             // 兼容已有的 blob url (虽然通常 chunks 会有数据，但以防万一)
             const response = await fetch(recordingUrl);
             const arrayBuffer = await response.arrayBuffer();
             vocalBuffer = await ctx.decodeAudioData(arrayBuffer);
        }

        if (!vocalBuffer) {
            showToast("无录音数据");
            return;
        }

        const vocalSource = ctx.createBufferSource();
        vocalSource.buffer = vocalBuffer;
        
        // 人声增益控制
        const vocalGain = ctx.createGain();
        vocalGain.gain.value = vocalVolume;
        previewGainRef.current = vocalGain;

        vocalSource.connect(vocalGain);
        vocalGain.connect(ctx.destination);

        // 2. 准备伴奏源 (如果有)
        let backingSource = null;
        if (backingBufferRef.current) {
            backingSource = ctx.createBufferSource();
            backingSource.buffer = backingBufferRef.current;
            backingSource.connect(ctx.destination);
        }

        // 3. 同步播放
        const now = ctx.currentTime + 0.1; // 稍微延迟一点点以确保同步启动
        const seekTime = previewCurrentTime; // 从当前进度条位置开始
        
        // 应用延迟补偿逻辑
        const offsetSeconds = latencyOffset / 1000;
        
        let vocalPlayTime = now;
        let vocalBufferOffset = 0;
        
        // 计算人声播放参数
        if (offsetSeconds > 0) {
             // 人声推后
             if (seekTime < offsetSeconds) {
                 vocalPlayTime = now + (offsetSeconds - seekTime);
                 vocalBufferOffset = 0;
             } else {
                 vocalPlayTime = now;
                 vocalBufferOffset = seekTime - offsetSeconds;
             }
        } else {
             // 人声提前
             vocalPlayTime = now;
             vocalBufferOffset = -offsetSeconds + seekTime;
        }

        if (backingSource) {
            // 伴奏从 seekTime 开始播放
            backingSource.start(now, seekTime);
            // backingSource.onended = () => setIsPreviewPlaying(false); // 由 RAF 控制结束更准确
        } 
        
        // 播放人声 (注意边界检查，虽然 Web Audio API 通常能处理)
        if (vocalBufferOffset < vocalBuffer.duration) {
            vocalSource.start(vocalPlayTime, vocalBufferOffset);
        }

        previewSourceRef.current = {
            backing: backingSource,
            vocal: vocalSource
        };
        
        previewStartTimeRef.current = now;
        previewStartOffsetRef.current = seekTime;
        setIsPreviewPlaying(true);

    } catch (err) {
        console.error("Preview failed:", err);
        showToast("预览播放失败");
        setIsPreviewPlaying(false);
    }
  };

  const discardRecording = () => {
    stopPreview();
    setRecordingBlob(null);
    setRecordingUrl(null);
    audioChunksRef.current = [];
    setShowPreviewModal(false);
    showToast("录音已丢弃");
  };

  const keepRecording = () => {
      stopPreview();
      setShowPreviewModal(false);
  };

  const setupVisualizer = (sourceNode) => {
    if (!audioContextRef.current || !canvasRef.current) return;
    
    const audioCtx = audioContextRef.current;
    const analyser = audioCtx.createAnalyser();
    
    sourceNode.connect(analyser);

    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      canvasCtx.fillStyle = 'rgb(20, 20, 25)';
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for(let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;
        const gradient = canvasCtx.createLinearGradient(0, canvas.height, 0, 0);
        gradient.addColorStop(0, '#8b5cf6');
        gradient.addColorStop(1, '#ec4899');
        canvasCtx.fillStyle = gradient;
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };
    draw();
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleExport = () => {
    if (recordingUrl) {
      const a = document.createElement('a');
      a.href = recordingUrl;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `Vocal_Track_${date}.wav`; 
      a.click();
    }
  };

  const formatTime = (time) => {
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getNextText = () => {
    if (currentLineIndex === -1 && lyrics.length > 0) return lyrics[0].text;
    if (lyrics[currentLineIndex + 1]) return lyrics[currentLineIndex + 1].text;
    return "— End —";
  };

  const renderCurrentLine = () => {
    if (currentLineIndex === -1 || !lyrics[currentLineIndex]) {
        return <span className="text-slate-500 text-2xl">等待开始...</span>;
    }

    const line = lyrics[currentLineIndex];

    if (line.words.length <= 1) {
        return (
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-300 via-pink-200 to-white">
                {line.text}
            </span>
        );
    }

    return line.words.map((word, idx) => {
        const timeSinceStart = currentTime - word.time;
        let percentage = 0;
        
        if (timeSinceStart <= 0) {
            percentage = 0;
        } else if (timeSinceStart >= word.duration) {
            percentage = 100;
        } else {
            percentage = (timeSinceStart / word.duration) * 100;
        }

        const edgeWidth = percentage > 0 ? 10 : 0; 
        
        const gradientStyle = {
            backgroundImage: `linear-gradient(to right, 
                #a78bfa 0%, 
                #f9a8d4 ${percentage}%, 
                #475569 ${Math.min(percentage + edgeWidth, 100)}%, 
                #475569 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            display: 'inline-block',
            willChange: 'background-image', 
        };
        
        return (
            <span 
                key={idx} 
                style={gradientStyle}
            >
                {word.text}
            </span>
        );
    });
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans select-none overflow-hidden relative">
      
      {toastMessage && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-50 bg-slate-800 border border-slate-600 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-top-4 duration-300">
            <AlertCircle size={18} className="text-violet-400" />
            <span className="text-sm font-medium">{toastMessage}</span>
        </div>
      )}

      {/* 顶部栏 */}
      <header className="h-16 border-b border-slate-700 flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md z-10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-pink-500 rounded-lg flex items-center justify-center">
            <Mic size={20} className="text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-pink-400">
            PureSing 纯净K歌
          </h1>
        </div>
        
        <div className="flex items-center gap-4 text-sm text-slate-400">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full ${micPermission ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                <Mic size={14} />
                <span>{micPermission ? "麦克风就绪" : "麦克风未授权"}</span>
            </div>
        </div>
      </header>

      {/* 主体区域 */}
      <main className="flex-1 flex overflow-hidden min-h-0">
        
        {/* 左侧控制面板 */}
        <aside className="w-80 border-r border-slate-700 bg-slate-800/30 p-6 flex flex-col gap-6 shrink-0 z-10 overflow-y-auto">
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">第1步：资源导入</h2>
            
            <div className="group relative border-2 border-dashed border-slate-600 rounded-xl p-4 hover:border-violet-500 hover:bg-slate-700/30 transition-all cursor-pointer text-center">
              <input type="file" accept="audio/*" onChange={handleAudioUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
              <div className="flex flex-col items-center gap-2">
                <Music className="text-slate-400 group-hover:text-violet-400" />
                <span className="text-sm font-medium text-slate-300 truncate w-full">
                  {audioFile ? audioFile.name : "点击导入伴奏 (MP3/WAV)"}
                </span>
              </div>
            </div>

            <div className="group relative border-2 border-dashed border-slate-600 rounded-xl p-4 hover:border-pink-500 hover:bg-slate-700/30 transition-all cursor-pointer text-center">
              <input type="file" accept=".lrc,.txt,.srt,.ass" onChange={handleLyricUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
              <div className="flex flex-col items-center gap-2">
                <FileText className="text-slate-400 group-hover:text-pink-400" />
                <span className="text-sm font-medium text-slate-300 truncate w-full">
                  {lyricFileName || "导入歌词 (LRC/SRT/ASS)"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">第2步：麦克风与导出</h2>
            <div className="h-32 bg-black/40 rounded-xl overflow-hidden border border-slate-700 shadow-inner relative">
                <canvas ref={canvasRef} width={270} height={128} className="w-full h-full" />
                {!isPlaying && <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">等待开始...</div>}
            </div>

            <div className="flex items-center justify-between mt-2">
                 <span className="text-sm text-slate-400">耳返监听 (Beta)</span>
                 <button 
                    onClick={() => setMonitorMic(!monitorMic)}
                    className={`w-12 h-6 rounded-full transition-colors relative ${monitorMic ? 'bg-violet-500' : 'bg-slate-600'}`}
                 >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${monitorMic ? 'left-7' : 'left-1'}`} />
                 </button>
            </div>

            <div className="flex flex-col gap-2 mt-4 px-1">
                 <div className="flex justify-between text-xs text-slate-400">
                    <span>人声延迟补偿</span>
                    <span>{latencyOffset > 0 ? `+${latencyOffset}ms` : `${latencyOffset}ms`}</span>
                 </div>
                 <input 
                    type="range" 
                    min="-500" 
                    max="500" 
                    step="10"
                    value={latencyOffset}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      setLatencyOffset(value);
                      // 保存到 localStorage
                      localStorage.setItem('puresing_latencyOffset', value.toString());
                    }}
                    className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-violet-500"
                 />
                 <div className="flex justify-between text-[10px] text-slate-500">
                    <span>提前</span>
                    <span>推后</span>
                 </div>
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-slate-700 flex flex-col gap-3">
             <button 
                onClick={handleExport}
                disabled={!recordingUrl}
                className="w-full flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-xl transition-all font-medium"
             >
                <Download size={18} />
                <span>导出干声 WAV</span>
             </button>
             
             <button 
                onClick={handleExportMix}
                disabled={!recordingUrl || !backingBufferRef.current || isProcessing}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-pink-600 hover:from-violet-500 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-xl transition-all font-medium shadow-lg shadow-violet-900/20"
             >
                <Music size={18} />
                <span>{isProcessing ? "合成中..." : "导出完整作品"}</span>
             </button>
          </div>
        </aside>

        {/* 右侧 KTV 视窗 */}
        <div className="flex-1 relative bg-gradient-to-b from-slate-900 to-slate-800 flex flex-col min-h-0">
            <audio 
                ref={audioRef} 
                src={audioUrl} 
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={() => {
                    setIsPlaying(false);
                    stopRecording();
                    showToast("播放结束，可导出录音");
                }}
            />

            {/* 歌词展示 - 核心 KTV 模式 */}
            <div className="flex-1 w-full flex flex-col items-center justify-center p-8 text-center gap-10 overflow-hidden">
                {lyrics.length === 0 ? (
                    <div className="flex flex-col items-center gap-4 text-slate-600">
                        <Music size={64} className="opacity-20" />
                        <p className="text-lg">请先在左侧导入伴奏与歌词</p>
                    </div>
                ) : (
                    <>
                        {/* 当前句 - 逐字渲染 */}
                        <div className="min-h-[140px] flex flex-col justify-center animate-in slide-in-from-bottom-2 fade-in duration-500">
                            <span className="text-sm text-violet-400 font-medium tracking-widest mb-4 uppercase opacity-80">
                                {currentLineIndex >= 0 ? "Now Playing" : "Ready"}
                            </span>
                            <h2 className="text-4xl md:text-5xl lg:text-6xl font-black drop-shadow-2xl leading-tight px-4 transition-all cursor-default">
                                {renderCurrentLine()}
                            </h2>
                        </div>

                        {/* 下一句 - 预告 */}
                        <div className="min-h-[60px] flex flex-col justify-center opacity-40 transition-opacity duration-300">
                             <span className="text-xs text-slate-400 font-medium tracking-widest mb-2 uppercase">Next</span>
                             <p className="text-xl md:text-2xl text-slate-300 font-normal">
                                {getNextText()}
                             </p>
                        </div>
                    </>
                )}
            </div>

            {/* 底部控制条 */}
            <div className="h-28 bg-slate-900/80 backdrop-blur-lg border-t border-slate-700 flex items-center px-10 justify-between shrink-0 z-20 pb-4">
                <div className="flex flex-col w-48">
                    <span className="text-white font-medium truncate">{audioFile?.name || "未选择歌曲"}</span>
                    <span className="text-slate-500 text-xs mt-1">
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                </div>

                <div className="flex items-center gap-6">
                    <button 
                        onClick={() => {
                            if(audioRef.current) {
                                audioRef.current.currentTime = 0;
                                setCurrentTime(0); // 立即视觉复位
                                // 清空录音缓存
                                audioChunksRef.current = [];
                                setRecordingUrl(null);
                            }
                        }}
                        className="text-slate-400 hover:text-white transition-colors flex flex-col items-center gap-1"
                    >
                        <RefreshCcw size={20} />
                        <span className="text-[10px]">重唱</span>
                    </button>

                    <div className="flex flex-col items-center gap-2 relative">
                        {isPlaying && (
                             <button
                                onClick={handleSkipAndFinish}
                                className="absolute -top-12 left-1/2 -translate-x-1/2 bg-slate-800/90 text-violet-300 text-xs px-3 py-1 rounded-full border border-violet-500/30 hover:bg-violet-500 hover:text-white transition-all whitespace-nowrap animate-in fade-in slide-in-from-bottom-2"
                                title="提前结束录制，但保留完整伴奏结尾"
                             >
                                跳过尾奏
                             </button>
                        )}
                        <button 
                            onClick={togglePlay}
                            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg hover:scale-105 ${
                                !audioUrl ? 'bg-slate-700 hover:bg-slate-600' : 
                                isPlaying ? 'bg-slate-100 text-slate-900 shadow-white/20' : 'bg-gradient-to-r from-violet-600 to-pink-600 text-white shadow-violet-500/40'
                            }`}
                        >
                            {isPlaying ? <Square size={26} fill="currentColor" /> : <Play size={30} fill="currentColor" className="ml-1" />}
                        </button>
                    </div>

                     <div className="flex flex-col items-center gap-1 w-12">
                        <span className={`w-3 h-3 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`}></span>
                        <span className="text-[10px] text-slate-500 uppercase">{isRecording ? "WAV REC" : "Ready"}</span>
                    </div>
                </div>

                <div className="w-48 flex justify-end items-center gap-2 opacity-0 pointer-events-none">
                   {/* 占位符，保持布局平衡 */}
                </div>
            </div>
        </div>
      </main>
      {/* 录音完成预览模态框 */}
      {showPreviewModal && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-300">
            <div className="bg-slate-800 border border-slate-600 rounded-2xl p-8 w-96 shadow-2xl flex flex-col gap-6 items-center relative">
                <button 
                    onClick={keepRecording}
                    className="absolute top-4 right-4 text-slate-400 hover:text-white"
                >
                    <X size={20} />
                </button>
                
                <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center mb-2">
                        <Check size={24} />
                    </div>
                    <h3 className="text-xl font-bold text-white">录音完成</h3>
                    <p className="text-sm text-slate-400 text-center">
                        您可以直接预览混音效果，<br/>如果不满意可直接重新录制
                    </p>
                </div>

                {/* 预览进度条 */}
                <div className="w-full px-2">
                     <div className="flex justify-between text-xs text-slate-400 mb-2">
                        <span>{formatTime(previewCurrentTime)}</span>
                        <span>{formatTime(previewDuration)}</span>
                     </div>
                     <input 
                        type="range"
                        min="0"
                        max={previewDuration}
                        step="0.01"
                        value={previewCurrentTime}
                        onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setPreviewCurrentTime(val);
                            if (isPreviewPlaying) {
                                stopPreview(); // 拖动时暂停，用户需再次点击播放，或者在此处立即调用 playPreview(val) 实现拖动即播放(但需处理防抖)
                            }
                        }}
                        className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-violet-500"
                     />
                </div>

                {/* 人声响度调整 */}
                <div className="w-full px-2">
                    <div className="flex justify-between text-xs text-slate-400 mb-2">
                        <div className="flex items-center gap-2">
                            <Volume2 size={14} />
                            <span>人声响度</span>
                        </div>
                        <span>{Math.round(vocalVolume * 100)}%</span>
                    </div>
                    <input 
                        type="range" 
                        min="0" 
                        max="3" 
                        step="0.1"
                        value={vocalVolume}
                        onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setVocalVolume(val);
                            // 实时调整正在播放的预览音量
                            if (previewGainRef.current) {
                                // 平滑过渡
                                previewGainRef.current.gain.setTargetAtTime(val, audioContextRef.current.currentTime, 0.05);
                            }
                        }}
                        className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-violet-500"
                    />
                </div>

                <div className="w-full flex flex-col gap-3">
                     <button 
                        onClick={playPreview}
                        className={`w-full h-14 rounded-xl flex items-center justify-center gap-3 transition-all font-medium text-lg ${
                            isPreviewPlaying 
                            ? 'bg-slate-700 text-white hover:bg-slate-600' 
                            : 'bg-gradient-to-r from-violet-500 to-pink-500 text-white hover:opacity-90 shadow-lg shadow-violet-900/20'
                        }`}
                     >
                        {isPreviewPlaying ? <Square fill="currentColor" size={20} /> : <Play fill="currentColor" size={20} />}
                        <span>{isPreviewPlaying ? "停止播放" : "试听回放"}</span>
                     </button>
                     
                     <div className="flex gap-3">
                         <button 
                            onClick={discardRecording}
                            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-slate-700/50 hover:bg-red-500/20 hover:text-red-400 text-slate-300 transition-colors border border-transparent hover:border-red-500/30"
                         >
                            <Trash2 size={18} />
                            <span>不满意重录</span>
                         </button>
                         <button 
                            onClick={keepRecording}
                            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-slate-700/50 hover:bg-green-500/20 hover:text-green-400 text-slate-300 transition-colors border border-transparent hover:border-green-500/30"
                         >
                            <Check size={18} />
                            <span>保留录音</span>
                         </button>
                     </div>
                </div>
            </div>
        </div>
      )}

    </div>
  );
}