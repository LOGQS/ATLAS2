// status: complete

import React, { useEffect } from 'react';
import '../../styles/ui/ModalWindow.css';

interface ModalWindowProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  showCloseButton?: boolean;
}

const ModalWindow: React.FC<ModalWindowProps> = ({
  isOpen,
  onClose,
  children,
  className = '',
  showCloseButton = true
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className={`modal-window ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {showCloseButton && (
          <button 
            className="modal-close-button" 
            onClick={onClose}
            aria-label="Close modal"
          >
            ×
          </button>
        )}
        {children}
      </div>
    </div>
  );
};

interface DeleteModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message?: string;
}

export const DeleteModal: React.FC<DeleteModalProps> = ({
  isOpen,
  onConfirm,
  onCancel,
  message = "Are you sure you want to delete this chat?"
}) => {
  return (
    <ModalWindow isOpen={isOpen} onClose={onCancel} className="deletemodal" showCloseButton={false}>
      <div className="delete-confirmation-content">
        <p>{message}</p>
        <div className="delete-confirmation-buttons">
          <button 
            className="delete-confirm-btn"
            onClick={onConfirm}
          >
            Delete
          </button>
          <button 
            className="delete-cancel-btn"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalWindow>
  );
};

export default ModalWindow;