import React, { useState, useEffect } from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';
import logger from '../../utils/core/logger';

export const ProfileSetupView: React.FC = () => {
  const {
    profileStatus,
    launchProfileSetup,
    checkProfileStatus,
    setShowProfileSetup,
    setProfileStatus
  } = useWebContext();

  const [setupLaunched, setSetupLaunched] = useState(false);

  const handleLaunchSetup = async () => {
    logger.info('[PROFILE_SETUP] Launching browser profile setup');
    setSetupLaunched(true);
    await launchProfileSetup();
  };

  // Listen for profile updates via SSE (event-driven, not polling)
  useEffect(() => {
    if (!setupLaunched) return;

    const handleProfileUpdate = (event: Event) => {
      const customEvent = event as CustomEvent;
      const detail = customEvent.detail;

      logger.info('[PROFILE_SETUP] Received profile update via SSE:', detail);

      if (detail.exists && detail.status === 'ready') {
        setProfileStatus('ready');
        logger.info('[PROFILE_SETUP] Profile setup completed!');
      } else if (!detail.exists) {
        setProfileStatus('missing');
      }
    };

    // Listen for SSE events from LiveStore
    window.addEventListener('webProfileUpdated', handleProfileUpdate);

    // Also check when tab becomes visible as fallback
    const handleVisibilityChange = async () => {
      if (!document.hidden) {
        logger.info('[PROFILE_SETUP] Tab became visible, checking profile status');
        await checkProfileStatus();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('webProfileUpdated', handleProfileUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [setupLaunched, checkProfileStatus, setProfileStatus]);

  return (
    <div className="profile-setup-view">
      <div className="profile-setup-view__container">
        {/* Header */}
        <div className="profile-setup-view__header">
          <div className="profile-setup-view__icon">
            <Icons.Globe className="w-16 h-16 text-cyan-400" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">
            Browser Profile Setup Required
          </h1>
          <p className="text-gray-400 text-center max-w-2xl">
            To use web browsing features with enhanced anti-bot detection, you need to create a managed browser profile.
            This is a one-time setup process.
          </p>
        </div>

        {/* Instructions */}
        <div className="profile-setup-view__content">
          <div className="profile-setup-view__card">
            <h2 className="text-lg font-semibold text-white mb-4">What will happen:</h2>
            <ol className="profile-setup-view__steps">
              <li className="profile-setup-view__step">
                <div className="profile-setup-view__step-number">1</div>
                <div className="profile-setup-view__step-content">
                  <h3 className="font-medium text-white">Browser Window Opens</h3>
                  <p className="text-gray-400 text-sm mt-1">
                    A new Chromium browser window will open in a separate process
                  </p>
                </div>
              </li>
              <li className="profile-setup-view__step">
                <div className="profile-setup-view__step-number">2</div>
                <div className="profile-setup-view__step-content">
                  <h3 className="font-medium text-white">Accept Cookies & Consent</h3>
                  <p className="text-gray-400 text-sm mt-1">
                    Accept Google's cookie/consent prompts when they appear
                  </p>
                </div>
              </li>
              <li className="profile-setup-view__step">
                <div className="profile-setup-view__step-number">3</div>
                <div className="profile-setup-view__step-content">
                  <h3 className="font-medium text-white">Solve CAPTCHA (if shown)</h3>
                  <p className="text-gray-400 text-sm mt-1">
                    Complete any CAPTCHA challenges that may appear
                  </p>
                </div>
              </li>
              <li className="profile-setup-view__step">
                <div className="profile-setup-view__step-number">4</div>
                <div className="profile-setup-view__step-content">
                  <h3 className="font-medium text-white">Close Browser Window</h3>
                  <p className="text-gray-400 text-sm mt-1">
                    When finished, close the browser window to save your profile
                  </p>
                </div>
              </li>
            </ol>
          </div>

          {/* Status */}
          {setupLaunched && (
            <div className="profile-setup-view__status">
              <div className="flex items-center gap-3 mb-3">
                {profileStatus === 'ready' ? (
                  <>
                    <Icons.CheckCircle className="w-5 h-5 text-green-400" />
                    <p className="text-green-400 font-medium">Profile created successfully!</p>
                  </>
                ) : (
                  <>
                    <div className="w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-cyan-400 font-medium">Waiting for setup completion...</p>
                  </>
                )}
              </div>
              <p className="text-gray-400 text-sm">
                Complete the steps in the browser window, then close it. The profile will be detected automatically.
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="profile-setup-view__actions">
            {!setupLaunched ? (
              <button
                onClick={handleLaunchSetup}
                className="profile-setup-view__btn profile-setup-view__btn--primary"
                disabled={profileStatus === 'setting_up'}
              >
                <Icons.Play className="w-5 h-5" />
                <span>Launch Setup Wizard</span>
              </button>
            ) : profileStatus === 'ready' ? (
              <button
                onClick={() => setShowProfileSetup(false)}
                className="profile-setup-view__btn profile-setup-view__btn--primary"
              >
                <Icons.CheckCircle className="w-5 h-5" />
                <span>Continue to Web Browser</span>
              </button>
            ) : (
              <div className="text-center">
                <p className="text-gray-400 text-sm">
                  Waiting for you to complete the setup in the browser window...
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
