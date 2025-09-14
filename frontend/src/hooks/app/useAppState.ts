// status: complete

import { useState } from 'react';
import logger from '../../utils/core/logger';

export const useAppState = () => {
  const [activeModal, setActiveModal] = useState<string | null>(null);

  const handleOpenModal = (modalType: string) => {
    logger.info('Opening modal:', modalType);
    setActiveModal(modalType);
  };

  const handleCloseModal = () => {
    logger.info('Closing modal');
    setActiveModal(null);
  };

  return {
    activeModal,
    handleOpenModal,
    handleCloseModal
  };
};