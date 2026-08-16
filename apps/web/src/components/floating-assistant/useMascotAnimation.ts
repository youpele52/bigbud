import { useEffect, useRef, useState } from "react";

import { collectCompletedThreadCandidates } from "~/notifications/taskCompletion.logic";
import { useStore } from "~/stores/main";

import {
  deriveMascotWorkState,
  hasAssistantStreamProgress,
  hasNewAgentUncertainty,
  hasNewCelebratoryFeedback,
  type MascotAnimation,
} from "./mascotAnimation.logic";

const GREETING_DURATION_MS = 1_800;
const CELEBRATION_DURATION_MS = 2_600;
const UNCERTAINTY_HOLD_DURATION_MS = 4_000;
const TYPING_IDLE_TIMEOUT_MS = 900;

export function useMascotAnimation(isHovered: boolean): {
  animation: MascotAnimation;
  animationKey: string;
} {
  const threads = useStore((state) => state.threads);
  const previousThreadsRef = useRef<typeof threads | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const uncertaintyTimerRef = useRef<number | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const [isGreeting, setIsGreeting] = useState(true);
  const [isCelebrating, setIsCelebrating] = useState(false);
  const [isUncertain, setIsUncertain] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [celebrationRevision, setCelebrationRevision] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsGreeting(false), GREETING_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const previousThreads = previousThreadsRef.current;
    previousThreadsRef.current = threads;
    if (previousThreads === null || (previousThreads.length === 0 && threads.length > 0)) return;

    if (hasAssistantStreamProgress(previousThreads, threads)) {
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
      }
      setIsTyping(true);
      typingTimerRef.current = window.setTimeout(() => {
        typingTimerRef.current = null;
        setIsTyping(false);
      }, TYPING_IDLE_TIMEOUT_MS);
    }

    const agentBecameUncertain = hasNewAgentUncertainty(previousThreads, threads);
    if (agentBecameUncertain) {
      if (uncertaintyTimerRef.current !== null) {
        window.clearTimeout(uncertaintyTimerRef.current);
      }
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      setIsTyping(false);
      setIsUncertain(true);
      uncertaintyTimerRef.current = window.setTimeout(() => {
        uncertaintyTimerRef.current = null;
        setIsUncertain(false);
      }, UNCERTAINTY_HOLD_DURATION_MS);
    }

    const shouldCelebrate =
      collectCompletedThreadCandidates(previousThreads, threads).length > 0 ||
      hasNewCelebratoryFeedback(previousThreads, threads);
    if (!shouldCelebrate || agentBecameUncertain) return;

    if (celebrationTimerRef.current !== null) {
      window.clearTimeout(celebrationTimerRef.current);
    }
    setIsCelebrating(true);
    setCelebrationRevision((revision) => revision + 1);
    celebrationTimerRef.current = window.setTimeout(() => {
      celebrationTimerRef.current = null;
      setIsCelebrating(false);
    }, CELEBRATION_DURATION_MS);
  }, [threads]);

  useEffect(
    () => () => {
      if (celebrationTimerRef.current !== null) {
        window.clearTimeout(celebrationTimerRef.current);
      }
      if (uncertaintyTimerRef.current !== null) {
        window.clearTimeout(uncertaintyTimerRef.current);
      }
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
      }
    },
    [],
  );

  const workState = deriveMascotWorkState(threads);
  const agentIsUncertain = isUncertain || workState.agentUncertain;
  const assistantIsActivelyTyping = isTyping && workState.animation === "thinking";
  const animation: MascotAnimation = agentIsUncertain
    ? "thinking"
    : isCelebrating
      ? "celebration"
      : isHovered || isGreeting
        ? "wave"
        : assistantIsActivelyTyping
          ? "typing"
          : workState.animation;

  return { animation, animationKey: `${animation}:${celebrationRevision}` };
}
