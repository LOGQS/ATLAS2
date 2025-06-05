import React, { useEffect, useRef } from 'react';

interface SummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  summary: string;
  onUseSummary?: () => void;
}

const SummaryModal: React.FC<SummaryModalProps> = ({ isOpen, onClose, summary, onUseSummary }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node) && isOpen) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay animate-fade-in">
      <div ref={modalRef} className="modal-container animate-fade-in">
        <div className="modal-header">
          <h3>Chat Summary</h3>
        </div>
        <div className="modal-content">
          <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', margin: 0 }}>{summary}</pre>
        </div>
        <div className="modal-footer">
          {onUseSummary && (
            <button className="modal-button confirm-button" onClick={onUseSummary}>
              Use Summary
            </button>
          )}
          <button className="modal-button cancel-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SummaryModal;
