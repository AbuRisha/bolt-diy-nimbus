
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "framer-motion";
import { AlertCircle, Bot, Check, Eye, Hammer, LoaderCircle, X } from "lucide-react";

export type CompanionState = "ready" | "thinking" | "building" | "watching" | "done" | "error";

type Pose = {
  x: number;
  y: number;
  facing: 1 | -1;
  jump: number;
};

const COPY: Record<CompanionState, { label: string; detail: string }> = {
  ready: { label: "Ready", detail: "Nimbus is ready for the next turn." },
  thinking: { label: "Thinking", detail: "The selected model is responding." },
  building: { label: "Building", detail: "Agents and tools are working live." },
  watching: { label: "Watching", detail: "A saved run is available to inspect." },
  done: { label: "Complete", detail: "The latest task finished successfully." },
  error: { label: "Needs attention", detail: "Open activity for the failure details." },
};

const STORAGE_KEY = "nimbus.companion.visible.v1";
const POSITION_KEY = "nimbus.companion.position.v1";

function StateIcon({ state }: { state: CompanionState }) {
  const cn = "h-3.5 w-3.5";
  if (state === "thinking") return <LoaderCircle className={`${cn} animate-spin`} />;
  if (state === "building") return <Hammer className={cn} />;
  if (state === "watching") return <Eye className={cn} />;
  if (state === "done") return <Check className={cn} />;
  if (state === "error") return <AlertCircle className={cn} />;
  return <Bot className={cn} />;
}

function nextDelay(state: CompanionState) {
  if (state === "building") return 1150;
  if (state === "thinking") return 1650;
  if (state === "done") return 900;
  if (state === "error") return 2400;
  return 3200 + Math.random() * 2600;
}

function jumpHeight(state: CompanionState) {
  if (state === "done") return 45;
  if (state === "building") return 30;
  if (state === "error") return 8;
  if (state === "thinking") return 18;
  return 22;
}

export default function NimbusCompanion({ state }: { state: CompanionState }) {
  const reduceMotion = useReducedMotion();
  const habitatRef = useRef<HTMLDivElement>(null);
  const petRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const userPlacedRef = useRef(false);
  const [visible, setVisible] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [reaction, setReaction] = useState(0);
  const [pose, setPose] = useState<Pose>({ x: 0, y: 12, facing: 1, jump: 0 });
  const [gaze, setGaze] = useState({ x: 0, y: 0 });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    try {
      setVisible(window.localStorage.getItem(STORAGE_KEY) !== "false");
      const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) || "null") as { x?: unknown; y?: unknown } | null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        const x = Math.max(-(window.innerWidth - 100), Math.min(0, Number(saved.x)));
        const y = Math.max(0, Math.min(window.innerHeight - 170, Number(saved.y)));
        userPlacedRef.current = true;
        setPose((current) => ({ ...current, x, y }));
      }
    } catch { /* optional */ }
  }, []);

  useEffect(() => {
    if (reduceMotion || !visible) return;
    const followPointer = (event: PointerEvent) => {
      const rect = actorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height * 0.38);
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = Math.min(1, distance / 130);
      setGaze({
        x: Math.round((dx / distance) * 2.8 * strength * 10) / 10,
        y: Math.round((dy / distance) * 1.8 * strength * 10) / 10,
      });
    };
    window.addEventListener("pointermove", followPointer, { passive: true });
    return () => window.removeEventListener("pointermove", followPointer);
  }, [reduceMotion, visible]);

  const roam = useCallback((forcedState?: CompanionState) => {
    if (reduceMotion || draggingRef.current) return;
    const activeState = forcedState ?? stateRef.current;
    setPose((current) => {
      if (userPlacedRef.current) return { ...current, jump: current.jump + 1 };
      let nextX = -Math.round(18 + Math.random() * 190);
      let nextY = Math.round(6 + Math.random() * 58);

      if (activeState === "thinking") {
        nextX = current.x < -100 ? -24 : -192;
        nextY = 34;
      } else if (activeState === "building") {
        nextX = -Math.round(20 + Math.random() * 205);
        nextY = Math.round(5 + Math.random() * 34);
      } else if (activeState === "done") {
        nextX = -74;
        nextY = 4;
      } else if (activeState === "error") {
        nextX = current.x;
        nextY = 52;
      }

      return {
        x: nextX,
        y: nextY,
        facing: nextX < current.x ? -1 : 1,
        jump: current.jump + 1,
      };
    });
  }, [reduceMotion]);

  useEffect(() => {
    if (reduceMotion || !visible) return;
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        roam();
        schedule();
      }, nextDelay(stateRef.current));
    };
    roam(state);
    schedule();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [reduceMotion, roam, state, visible]);

  const react = () => {
    setReaction((value) => value + 1);
    setExpanded(false);
    roam("done");
  };

  const persistPosition = useCallback((x: number, y: number) => {
    userPlacedRef.current = true;
    try { window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x, y })); } catch { /* optional */ }
  }, []);

  const moveByKeyboard = (dx: number, dy: number) => {
    setPose((current) => {
      const x = Math.max(-(window.innerWidth - 100), Math.min(0, current.x + dx));
      const y = Math.max(0, Math.min(window.innerHeight - 170, current.y + dy));
      persistPosition(x, y);
      return { ...current, x, y, facing: dx < 0 ? -1 : dx > 0 ? 1 : current.facing, jump: current.jump + 1 };
    });
  };

  const finishDrag = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    draggingRef.current = false;
    const habitat = habitatRef.current?.getBoundingClientRect();
    const pet = petRef.current?.getBoundingClientRect();
    if (!habitat || !pet) return;
    const baseLeft = habitat.right - 12 - pet.width;
    const baseTop = habitat.top + 48;
    const droppedX = Math.max(-(habitat.width - 100), Math.min(0, pet.left - baseLeft));
    const droppedY = Math.max(0, Math.min(habitat.height - 170, pet.top - baseTop));
    setPose((current) => {
      persistPosition(droppedX, droppedY);
      return { ...current, x: droppedX, y: droppedY, facing: info.offset.x < 0 ? -1 : info.offset.x > 0 ? 1 : current.facing, jump: current.jump + 1 };
    });
  };

  const setVisibility = (next: boolean) => {
    setVisible(next);
    try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* optional */ }
  };

  const hop = jumpHeight(state);
  const copy = COPY[state];
  const statusColor = state === "error" ? "bg-rose-400" : state === "thinking" || state === "building" ? "bg-amber-300" : "bg-emerald-400";
  const travelTransition = useMemo(() => ({ type: "spring" as const, stiffness: state === "building" ? 115 : 72, damping: 16, mass: 0.8 }), [state]);

  return (
    <div ref={habitatRef} className="pointer-events-none absolute inset-0 z-20 hidden overflow-hidden md:block" aria-live="polite">
      <AnimatePresence mode="wait">
        {!visible ? (
          <motion.button
            key="restore"
            type="button"
            aria-label="Show Nimbus companion"
            title="Show Nimbus companion"
            onClick={() => setVisibility(true)}
            className="pointer-events-auto absolute right-1 top-2 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#111827]/90 text-cyan-200 shadow-lg backdrop-blur"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.75 }}
            animate={{ opacity: 1, scale: 1 }}
          ><Bot className="h-4 w-4" /></motion.button>
        ) : (
          <motion.div key="pet" className="absolute inset-0" initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
            <motion.div
              ref={petRef}
              drag
              dragConstraints={habitatRef}
              dragElastic={0.08}
              dragMomentum={false}
              onDragStart={() => { draggingRef.current = true; setExpanded(false); }}
              onDragEnd={finishDrag}
              className="pointer-events-auto absolute right-3 top-12 h-[116px] w-[82px] cursor-grab touch-none select-none active:cursor-grabbing"
              animate={{ x: pose.x, y: pose.y }}
              transition={travelTransition}
            >
              <motion.span
                key={`shadow-${pose.jump}`}
                className="absolute bottom-0 left-1/2 h-2 w-12 -translate-x-1/2 rounded-full bg-cyan-950/35 blur-[2px]"
                animate={reduceMotion ? undefined : { scaleX: [1, 0.52, 0.76, 1], opacity: [0.42, 0.15, 0.25, 0.42] }}
                transition={{ duration: state === "done" ? 0.75 : 0.95 }}
              />

              <motion.button
                ref={actorRef}
                key={`actor-${pose.jump}`}
                type="button"
                onClick={react}
                onDoubleClick={() => setExpanded((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") { event.preventDefault(); moveByKeyboard(-16, 0); }
                  if (event.key === "ArrowRight") { event.preventDefault(); moveByKeyboard(16, 0); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveByKeyboard(0, -16); }
                  if (event.key === "ArrowDown") { event.preventDefault(); moveByKeyboard(0, 16); }
                }}
                aria-expanded={expanded}
                aria-label={`${copy.label}. Draggable Nimbus companion. Drag to move, use arrow keys to reposition, click to play, or double click for status.`}
                title="Drag Nimbus anywhere"
                className="absolute inset-x-0 top-0 h-[104px] w-[82px] cursor-inherit origin-bottom focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                initial={false}
                animate={reduceMotion ? { opacity: 1 } : state === "error"
                  ? { x: [0, -3, 3, -2, 2, 0], y: [0, -hop, 0], rotate: [0, -3, 3, -2, 2, 0], scaleX: [pose.facing, pose.facing * 0.96, pose.facing], scaleY: [1, 1.02, 0.96, 1] }
                  : { y: [0, -hop * 0.82, -hop, -hop * 0.56, 0, 2, 0], rotate: [0, pose.facing * 2, pose.facing * 4, 0, pose.facing * -2, 0], scaleX: [pose.facing, pose.facing * 0.96, pose.facing, pose.facing * 1.08, pose.facing], scaleY: [0.94, 1.08, 1.03, 0.96, 0.88, 1.05, 1] }}
                transition={{ duration: state === "done" ? 0.75 : state === "building" ? 0.85 : 0.95, ease: [0.34, 1.25, 0.64, 1] }}
              >
                <img src="/mascot/nimbus-companion.png" alt="" draggable={false} className="h-full w-full select-none object-contain [image-rendering:pixelated] drop-shadow-[0_8px_10px_rgba(34,211,238,0.22)]" />

                {[43.2, 66.4].map((left, index) => (
                  <span key={left} className="absolute top-[37.2%] h-[12%] w-[8.5%] overflow-hidden rounded-full" style={{ left: `${left - 4.25}%` }}>
                    <motion.span
                      className="absolute inset-0 origin-center rounded-full bg-[#20347d]"
                      animate={reduceMotion ? { scaleY: 0 } : { scaleY: [0, 0, 0, 1, 0, 0] }}
                      transition={{ duration: 4.4 + index * 0.35, repeat: Infinity, times: [0, 0.7, 0.79, 0.83, 0.88, 1] }}
                    />
                    <motion.span
                      className="absolute left-1/2 top-[22%] h-[2px] w-[2px] rounded-full bg-white/95 shadow-[0_0_3px_rgba(255,255,255,.8)]"
                      animate={{ x: gaze.x, y: gaze.y }}
                      transition={{ type: "spring", stiffness: 430, damping: 24 }}
                    />
                  </span>
                ))}
                <span className={`absolute bottom-[17%] right-[12%] h-2 w-2 rounded-full border border-[#07111B] ${statusColor}`} />
              </motion.button>

              <AnimatePresence>
                {reaction > 0 ? (
                  <motion.span
                    key={reaction}
                    className="absolute right-0 top-0 text-lg font-black text-cyan-200 drop-shadow-[0_0_8px_rgba(34,211,238,.8)]"
                    initial={{ opacity: 0, y: 25, scale: 0.5, rotate: -12 }}
                    animate={{ opacity: [0, 1, 1, 0], y: -30, scale: [0.5, 1.25, 1, 0.8], rotate: 8 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.9 }}
                  >+
                  </motion.span>
                ) : null}
              </AnimatePresence>

              <AnimatePresence initial={false}>
                {expanded ? (
                  <motion.div
                    className="pointer-events-auto absolute right-0 top-[112px] flex w-[210px] items-center gap-2 rounded-[8px] border border-white/10 bg-[#0B1220]/95 px-2.5 py-2 shadow-xl backdrop-blur-xl"
                    initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  >
                    <span className={state === "error" ? "text-rose-300" : "text-cyan-200"}><StateIcon state={state} /></span>
                    <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-white">{copy.label}</p><p className="truncate text-[10px] text-white/50">{copy.detail}</p></div>
                    <button type="button" onClick={() => setVisibility(false)} aria-label="Hide Nimbus companion" title="Hide Nimbus companion" className="flex h-7 w-7 items-center justify-center rounded-full text-white/35 hover:bg-white/[0.06] hover:text-white/75"><X className="h-3.5 w-3.5" /></button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
