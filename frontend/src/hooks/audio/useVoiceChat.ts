import { useState, useRef, useCallback, useEffect } from 'react';
import AudioRecorder from '../../utils/audio/audioRecorder';
import logger from '../../utils/core/logger';
import { apiUrl } from '../../config/api';

interface UseVoiceChatProps {
  onTranscriptionComplete?: (text: string) => void;
  holdDetectionMs?: number;
}

interface UseVoiceChatReturn {
  isButtonHeld: boolean;
  wasHoldCompleted: boolean;
  isRecording: boolean;
  isSoundDetected: boolean;
  isVoiceChatMode: boolean;

  handleButtonHoldStart: () => void;
  handleButtonHoldEnd: () => void;
  toggleVoiceChatMode: () => void;
  setVoiceChatMode: (value: boolean) => void;
}

export const useVoiceChat = ({
  onTranscriptionComplete,
  holdDetectionMs = 700
}: UseVoiceChatProps = {}): UseVoiceChatReturn => {
  const [isButtonHeld, setIsButtonHeld] = useState(false);
  const [wasHoldCompleted, setWasHoldCompleted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSoundDetected, setIsSoundDetected] = useState(false);
  const [isVoiceChatMode, setIsVoiceChatMode] = useState(false);

  const holdTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);

  useEffect(() => {
    return () => {
      if (audioRecorderRef.current && audioRecorderRef.current.isCurrentlyRecording()) {
        audioRecorderRef.current.stopRecording().catch(error => {
          logger.error('[AUDIO_RECORDING] Error stopping recording on unmount:', error);
        });
      }
    };
  }, []);

  const handleButtonHoldEnd = useCallback(async () => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    if (isButtonHeld) {
      setIsButtonHeld(false);
      logger.debug('[HOLD_DETECTION] Send button hold released - stopping animation');

      setTimeout(() => {
        setWasHoldCompleted(false);
      }, 100);

      if (isRecording && audioRecorderRef.current) {
        try {
          logger.info('[AUDIO_RECORDING] Stopping recording...');
          const audioBlob = await audioRecorderRef.current.stopRecording();
          setIsRecording(false);
          setIsSoundDetected(false);
          logger.info('[AUDIO_RECORDING] Recording stopped, blob size:', audioBlob.size, 'type:', audioBlob.type);

          const formData = new FormData();
          formData.append('audio', audioBlob, 'recording.wav');
          logger.info('[STT_TRANSCRIBE] Sending audio to backend for transcription...');

          const response = await fetch(apiUrl('/api/stt/transcribe'), {
            method: 'POST',
            body: formData
          });

          if (response.ok) {
            const result = await response.json();
            logger.info('[STT_TRANSCRIBE] Transcription response:', result);

            if (result.success && result.text) {
              if (onTranscriptionComplete) {
                onTranscriptionComplete(result.text);
              }
              logger.info('[STT_TRANSCRIBE] Transcription successful, text:', result.text);
            } else {
              logger.warn('[STT_TRANSCRIBE] Transcription returned but no text:', result);
            }
          } else {
            const errorText = await response.text();
            logger.error('[STT_TRANSCRIBE] Failed to transcribe audio, status:', response.status, 'error:', errorText);
          }
        } catch (error) {
          logger.error('[AUDIO_RECORDING] Error processing recording:', error);
        }
      }
    }
  }, [isButtonHeld, isRecording, onTranscriptionComplete]);

  const handleButtonHoldStart = useCallback(() => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
    }

    setWasHoldCompleted(false);

    holdTimeoutRef.current = setTimeout(async () => {
      setIsButtonHeld(true);
      setWasHoldCompleted(true);
      logger.debug('[HOLD_DETECTION] Send button hold detected - starting animation and recording');

      try {
        if (!audioRecorderRef.current) {
          audioRecorderRef.current = new AudioRecorder({
            onAudioLevelUpdate: (_level: number, soundDetected: boolean) => {
              setIsSoundDetected(soundDetected);
            },
            onMaxDurationReached: () => {
              logger.warn('[AUDIO_RECORDING] Maximum recording duration (1 hour) reached');
              handleButtonHoldEnd();
            }
          });
        }
        await audioRecorderRef.current.startRecording();
        setIsRecording(true);
        setIsSoundDetected(false);
        logger.info('[AUDIO_RECORDING] Recording session started successfully');
      } catch (error) {
        logger.error('[AUDIO_RECORDING] Failed to start recording:', error);
      }
    }, holdDetectionMs);
  }, [handleButtonHoldEnd, holdDetectionMs]);

  const toggleVoiceChatMode = useCallback(() => {
    setIsVoiceChatMode(prev => {
      const newMode = !prev;
      logger.info(`[VOICE_CHAT] Voice chat mode toggled: ${newMode}`);
      return newMode;
    });
  }, []);

  return {
    isButtonHeld,
    wasHoldCompleted,
    isRecording,
    isSoundDetected,
    isVoiceChatMode,

    handleButtonHoldStart,
    handleButtonHoldEnd,
    toggleVoiceChatMode,
    setVoiceChatMode: setIsVoiceChatMode
  };
};