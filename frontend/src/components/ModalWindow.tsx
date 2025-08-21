// status: complete

import React from 'react';
import '../styles/ModalWindow.css';

interface ModalWindowProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

const ModalWindow: React.FC<ModalWindowProps> = ({
  isOpen,
  onClose,
  children,
  className = ''
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className={`modal-window ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
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
    <ModalWindow isOpen={isOpen} onClose={onCancel} className="deletemodal">
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