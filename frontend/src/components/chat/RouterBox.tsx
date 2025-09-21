// status: complete
import React, { useState, useEffect, useRef } from 'react';
import '../../styles/chat/RouterBox.css';
import logger from '../../utils/core/logger';


interface RouterDecision {
  selectedRoute: string | null;
  availableRoutes: any[];
  selectedModel: string | null;
}

interface RouterBoxProps {
  routerDecision: RouterDecision | null;
  isProcessing?: boolean;
  isVisible?: boolean;
  chatId?: string;
  messageId?: string;
  chatScrollControl?: {
    shouldAutoScroll: () => boolean;
    onStreamStart: () => void;
    resetToAutoScroll: () => void;
  };
}

const RouterBox: React.FC<RouterBoxProps> = ({
  routerDecision,
  isProcessing = false,
  isVisible = true,
  chatId,
  messageId,
  chatScrollControl
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [hasAnimated, setHasAnimated] = useState(false);
  const [animationPhase, setAnimationPhase] = useState<'idle' | 'expanding' | 'scrolling' | 'collapsing'>('idle');
  const [scrollPosition, setScrollPosition] = useState(0);
  const [markedRoutes, setMarkedRoutes] = useState<Set<string>>(new Set());
  const routerContentRef = useRef<HTMLDivElement>(null);

  const selectedRoute = routerDecision?.selectedRoute || null;
  const availableRoutes = routerDecision?.availableRoutes || [];

  const allRoutes = availableRoutes;

  useEffect(() => {
    const isLiveOverlay = messageId?.startsWith('live_router_');
    const isPlaceholder = messageId?.startsWith('temp_');
    const shouldAnimate = isLiveOverlay || isPlaceholder;
    logger.info(`[ROUTERBOX] Animation trigger check: selectedRoute=${selectedRoute}, hasAnimated=${hasAnimated}, isLiveOverlay=${isLiveOverlay}, isPlaceholder=${isPlaceholder}, shouldAnimate=${shouldAnimate}, messageId=${messageId}`);

    if (selectedRoute && !hasAnimated && shouldAnimate) {
      const playRoutingAnimation = async () => {
        setHasAnimated(true);
        setIsCollapsed(false);
        setAnimationPhase('expanding');

        logger.info(`[ROUTERBOX] Starting routing animation for ${chatId}`);

        await new Promise(resolve => setTimeout(resolve, 200));

        setAnimationPhase('scrolling');

        const selectedIndex = allRoutes.findIndex(r => r.route_name === selectedRoute);
        if (selectedIndex === -1) {
          setAnimationPhase('collapsing');
          setTimeout(() => {
            setIsCollapsed(true);
            setAnimationPhase('idle');
          }, 200);
          return;
        }

        const routeHeight = 48;
        const totalScrollDistance = selectedIndex * routeHeight;
        const scrollDuration = 350;
        const scrollSteps = 20;
        const stepDuration = scrollDuration / scrollSteps;

        for (let i = 0; i <= scrollSteps; i++) {
          const progress = i / scrollSteps;
          const currentScroll = totalScrollDistance * progress;
          setScrollPosition(currentScroll);

          const passedRouteIndex = Math.floor(currentScroll / routeHeight);
          const newMarked = new Set<string>();
          for (let j = 0; j < passedRouteIndex; j++) {
            if (allRoutes[j]) {
              newMarked.add(allRoutes[j].route_name);
            }
          }

          if (progress >= 0.99 && selectedRoute) {
            newMarked.add(selectedRoute);
          }

          setMarkedRoutes(newMarked);
          await new Promise(resolve => setTimeout(resolve, stepDuration));
        }

        await new Promise(resolve => setTimeout(resolve, 200));

        setAnimationPhase('collapsing');
        setTimeout(() => {
          setIsCollapsed(true);
          setAnimationPhase('idle');
          logger.info(`[ROUTERBOX] Routing animation completed for ${chatId}`);

          try {
            window.dispatchEvent(new CustomEvent('chatContentResized', {
              detail: { chatId, messageId, source: 'routerbox', collapsed: true }
            }));
          } catch {}
        }, 200);
      };

      playRoutingAnimation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoute, hasAnimated, chatId, messageId]);

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    logger.info(`[ROUTERBOX] Manual toggle collapse for ${chatId}: ${next}`);
    try {
      window.dispatchEvent(new CustomEvent('chatContentResized', {
        detail: { chatId, messageId, source: 'routerbox', collapsed: next }
      }));
    } catch {}
  };

  logger.info(`[ROUTERBOX_VISIBILITY] RouterBox visibility check for ${chatId}: isVisible=${isVisible}, hasRouterDecision=${!!routerDecision}, isProcessing=${isProcessing}, selectedRoute=${routerDecision?.selectedRoute}`);

  if (!isVisible || (!routerDecision && !isProcessing)) {
    logger.info(`[ROUTERBOX_VISIBILITY] RouterBox hidden for ${chatId}: isVisible=${isVisible}, hasRouterDecision=${!!routerDecision}, isProcessing=${isProcessing}`);
    return null;
  }

  logger.info(`[ROUTERBOX_VISIBILITY] RouterBox visible for ${chatId}: route=${routerDecision?.selectedRoute}, processing=${isProcessing}`);

  const getRouteStatus = (routeName: string) => {
    if (routeName === selectedRoute) {
      return 'selected';
    }
    if (markedRoutes.has(routeName)) {
      return 'not-selected';
    }
    return 'pending';
  };

  return (
    <div className="router-box">
      <div
        className="router-box-header"
        onClick={toggleCollapse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            toggleCollapse();
          }
        }}
      >
        <div className="router-box-title">
          <div className="router-icon"></div>
          <span className="router-label">
            {isProcessing && !selectedRoute ? 'Routing...' : 'Routed'}
          </span>
          {selectedRoute && (
            <div className="selected-route-badge">
              <div className="route-badge-glow"></div>
              <span className="route-badge-text">{selectedRoute}</span>
            </div>
          )}
          {isProcessing && !selectedRoute && (
            <div className="routing-indicator">
              <div className="ice-crystal"></div>
              <div className="ice-crystal"></div>
              <div className="ice-crystal"></div>
            </div>
          )}
        </div>
        <div className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>
          <div className="arrow-icon"></div>
        </div>
      </div>

      <div
        className={`router-box-content ${isCollapsed ? 'collapsed' : ''} ${animationPhase}`}
        ref={routerContentRef}
      >
        <div
          className="router-box-routes"
          style={{
            transform: `translateY(-${scrollPosition}px)`,
            transition: animationPhase === 'scrolling' ? 'transform 0.35s linear' : 'none'
          }}
        >
          {allRoutes.map((route) => (
            <div
              key={route.route_name}
              className={`route-item ${getRouteStatus(route.route_name)}`}
            >
              <div className={`route-indicator ${getRouteStatus(route.route_name)}`}>
                <div className="indicator-inner"></div>
              </div>
              <div className="route-info">
                <div className="route-name">{route.route_name}</div>
                <div className="route-model">{route.model || 'default'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default RouterBox;