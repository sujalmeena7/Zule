import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useInView } from 'framer-motion';

type Category = 'assist' | 'say' | 'followup';

const QA_DATA: Record<Category, { q: string; a: string }[]> = {
  assist: [
    {
      q: "Summarize the client's main concerns.",
      a: "They are worried about the migration timeline and data security. They need reassurance that downtime will be under 2 hours, and all data is encrypted at rest."
    },
    {
      q: "What was the agreed budget?",
      a: "The client agreed to a preliminary budget of $120,000 for the first phase, with a $15,000 contingency for unexpected API integration costs."
    },
    {
      q: "Did they mention any competitors?",
      a: "Yes, they briefly mentioned evaluating Acme Corp and Globex. They noted that Globex's pricing was lower but preferred our security compliance."
    }
  ],
  say: [
    {
      q: "What should I say about our Q3 growth?",
      a: "Revenue grew 34% QoQ driven by enterprise expansion. Our pipeline has 12 deals in late stage worth $2.4M ARR. Customer retention is at 96%, up from 91% last quarter."
    },
    {
      q: "How do I answer their question about scaling?",
      a: "Highlight our Kubernetes-based infrastructure. Mention that we auto-scale based on load and currently handle 50,000 requests per second for our largest enterprise client without degradation."
    },
    {
      q: "What's the best counter to their pricing objection?",
      a: "Remind them of the ROI. While our upfront cost is 15% higher, our automated workflows save an average of 20 hours per week per employee, paying for itself in month two."
    }
  ],
  followup: [
    {
      q: "What are the action items from this call?",
      a: "1. Sarah to send the technical whitepaper.\n2. You need to schedule a follow-up demo for next Tuesday.\n3. Send the revised pricing proposal by EOD."
    },
    {
      q: "Who is responsible for the security audit?",
      a: "Michael from the DevOps team was assigned the security audit. He committed to delivering the SOC2 compliance report by Friday."
    },
    {
      q: "Draft a quick follow-up email for this meeting.",
      a: "Hi Team,\nGreat meeting today. As discussed, we'll proceed with the pilot program. I've attached the pricing sheet. Please let me know your availability for the onboarding kickoff next week."
    }
  ]
};

export function AnimatedMockup() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  
  const [category, setCategory] = useState<Category>('say');
  const [pairIndex, setPairIndex] = useState(0);
  const [typingIndex, setTypingIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'typing' | 'thinking' | 'answering' | 'done'>('idle');

  const currentQA = QA_DATA[category][pairIndex];

  // Handle Category Change
  const handleCategoryClick = (newCategory: Category) => {
    if (category === newCategory) return;
    setCategory(newCategory);
    setPairIndex(0);
    setTypingIndex(0);
    setPhase('idle');
  };

  useEffect(() => {
    if (!isInView) return;
    if (phase === 'idle') {
      const startTimeout = setTimeout(() => setPhase('typing'), 400);
      return () => clearTimeout(startTimeout);
    }
  }, [isInView, phase]);

  useEffect(() => {
    if (phase === 'typing') {
      if (typingIndex < currentQA.q.length) {
        const timeout = setTimeout(() => {
          setTypingIndex(prev => prev + 1);
        }, 25); // Smooth, fast typing speed
        return () => clearTimeout(timeout);
      } else {
        const timeout = setTimeout(() => setPhase('thinking'), 500);
        return () => clearTimeout(timeout);
      }
    } else if (phase === 'thinking') {
      const timeout = setTimeout(() => setPhase('answering'), 1000);
      return () => clearTimeout(timeout);
    } else if (phase === 'answering') {
      const timeout = setTimeout(() => setPhase('done'), 4000);
      return () => clearTimeout(timeout);
    } else if (phase === 'done') {
      const timeout = setTimeout(() => {
        // Reset and go to next pair
        setPhase('idle');
        setTypingIndex(0);
        setPairIndex((prev) => (prev + 1) % QA_DATA[category].length);
      }, 2000); // Wait 2 seconds before starting the next question
      return () => clearTimeout(timeout);
    }
  }, [phase, typingIndex, currentQA.q.length, category]);

  const getPillLabel = () => {
    if (category === 'assist') return '✨ Assist';
    if (category === 'say') return '💬 What should I say?';
    if (category === 'followup') return '📋 Follow-up';
    return '✨ Assist';
  };

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
          {getPillLabel()}
        </motion.div>
        
        <div className="mockup-question">
          <span className="mockup-q-label">You asked:</span>
          <p className="typing-text">
            "{currentQA.q.substring(0, typingIndex)}"
            {phase === 'typing' && <motion.span animate={{ opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 0.7 }}>|</motion.span>}
          </p>
        </div>

        <div className="mockup-ai-response" style={{ minHeight: '120px', position: 'relative' }}>
          <AnimatePresence mode="wait">
            {phase === 'thinking' && (
              <motion.div
                key="thinking"
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
              <motion.p
                key={`answer-${category}-${pairIndex}`}
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: { opacity: 0 },
                  visible: { opacity: 1, transition: { staggerChildren: 0.02 } }
                }}
              >
                {currentQA.a.split(' ').map((word, i) => (
                  <motion.span
                    key={i}
                    variants={{
                      hidden: { opacity: 0, y: 8, filter: 'blur(3px)' },
                      visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.3, ease: "easeOut" } }
                    }}
                    style={{ display: 'inline-block', marginRight: '5px' }}
                  >
                    {word}
                  </motion.span>
                ))}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="mockup-bottom-bar">
          <div className="mockup-actions">
            <span 
              onClick={() => handleCategoryClick('assist')}
              style={{ cursor: 'pointer', opacity: category === 'assist' ? 1 : 0.6, transition: 'opacity 0.2s' }}
            >
              ✨ Assist
            </span>
            <span 
              onClick={() => handleCategoryClick('say')}
              style={{ cursor: 'pointer', opacity: category === 'say' ? 1 : 0.6, transition: 'opacity 0.2s' }}
            >
              💬 What should I say?
            </span>
            <span 
              onClick={() => handleCategoryClick('followup')}
              style={{ cursor: 'pointer', opacity: category === 'followup' ? 1 : 0.6, transition: 'opacity 0.2s' }}
            >
              📋 Follow-up
            </span>
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
