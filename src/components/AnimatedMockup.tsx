import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useInView } from 'framer-motion';

const QUESTION_TEXT = "What should I say about our Q3 growth?";
const ANSWER_TEXT = "Revenue grew 34% QoQ driven by enterprise expansion. Our pipeline has 12 deals in late stage worth $2.4M ARR. Customer retention is at 96%, up from 91% last quarter.";

export function AnimatedMockup() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [typingIndex, setTypingIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'typing' | 'thinking' | 'answering' | 'done'>('idle');

  useEffect(() => {
    if (!isInView) return;
    // Sequence Timeline
    const startTimeout = setTimeout(() => setPhase('typing'), 500);
    return () => clearTimeout(startTimeout);
  }, [isInView]);

  useEffect(() => {
    if (phase === 'typing') {
      if (typingIndex < QUESTION_TEXT.length) {
        const timeout = setTimeout(() => {
          setTypingIndex(prev => prev + 1);
        }, Math.random() * 50 + 30); // Random typing speed
        return () => clearTimeout(timeout);
      } else {
        const timeout = setTimeout(() => setPhase('thinking'), 500);
        return () => clearTimeout(timeout);
      }
    } else if (phase === 'thinking') {
      const timeout = setTimeout(() => setPhase('answering'), 1200);
      return () => clearTimeout(timeout);
    } else if (phase === 'answering') {
      const timeout = setTimeout(() => setPhase('done'), 3000);
      return () => clearTimeout(timeout);
    }
  }, [phase, typingIndex]);

  return (
    <motion.div
      ref={ref}
      className="stats-mockup"
      initial={{ opacity: 0, x: -40 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="mockup-overlay-card">
        <motion.div 
          className="mockup-mode-pill"
          animate={phase === 'thinking' ? { scale: [1, 1.05, 1], opacity: [0.8, 1, 0.8] } : {}}
          transition={{ repeat: Infinity, duration: 1.5 }}
        >
          ✨ Assist
        </motion.div>
        
        <div className="mockup-question">
          <span className="mockup-q-label">You asked:</span>
          <p className="typing-text">
            "{QUESTION_TEXT.substring(0, typingIndex)}"
            {phase === 'typing' && <motion.span animate={{ opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 0.7 }}>|</motion.span>}
          </p>
        </div>

        <div className="mockup-ai-response" style={{ minHeight: '120px', position: 'relative' }}>
          <AnimatePresence>
            {phase === 'thinking' && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{ display: 'flex', gap: '4px', position: 'absolute', top: 0, left: 0 }}
              >
                <motion.div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 0.6, delay: 0 }} />
                <motion.div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 0.6, delay: 0.2 }} />
                <motion.div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 0.6, delay: 0.4 }} />
              </motion.div>
            )}
            
            {(phase === 'answering' || phase === 'done') && (
              <motion.div
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: { opacity: 0 },
                  visible: { opacity: 1, transition: { staggerChildren: 0.05 } }
                }}
              >
                {ANSWER_TEXT.split(' ').map((word, i) => (
                  <motion.span
                    key={i}
                    variants={{
                      hidden: { opacity: 0, y: 10, filter: 'blur(4px)' },
                      visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.4, ease: "easeOut" } }
                    }}
                    style={{ display: 'inline-block', marginRight: '5px' }}
                  >
                    {word}
                  </motion.span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mockup-bottom-bar">
          <div className="mockup-actions">
            <span>✨ Assist</span>
            <span>💬 What should I say?</span>
            <span>📋 Follow-up</span>
          </div>
          <div className="mockup-input-bar">
            Ask about your screen or conversation...
          </div>
        </div>
      </div>
      <div className="mockup-caption">Zule overlay during a live meeting — undetectable by screenshare</div>
    </motion.div>
  );
}
