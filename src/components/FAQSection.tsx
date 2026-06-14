import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

const faqs = [
  {
    question: "How does Zule compare as a Cluely alternative?",
    answer: "If you are looking for a Cluely alternative, Zule is the superior choice for professionals. Unlike Cluely or regular AI notetakers that join your calls as awkward bots, Zule runs natively on your machine. It captures system audio directly, meaning it's completely invisible to other participants and requires no bot invites."
  },
  {
    question: "Who is Zule for?",
    answer: "Zule is for professionals, salespeople, and students who want a competitive edge in meetings. If you want perfect recall and instant summaries without announcing to the entire room that you're recording, Zule is for you."
  },
  {
    question: "Is Zule free?",
    answer: "Yes! Zule offers a generous free tier that lets you start transcribing and summarizing your meetings instantly without a credit card. We also plan to introduce premium features in the future for power users."
  },
  {
    question: "How is it undetectable in meetings?",
    answer: "Zule is a native desktop application, not a browser extension or a bot. It sits silently in the background and reads your system's audio output and microphone input. Because it doesn't join the meeting room, there is no visual indicator to other participants."
  },
  {
    question: "What apps are supported?",
    answer: "If it makes a sound on your computer, Zule can hear it. It works perfectly out of the box with Zoom, Google Meet, Microsoft Teams, Webex, Slack Huddles, and even standard audio/video files."
  },
  {
    question: "Can I talk to customer support?",
    answer: "Absolutely. You can reach out to us anytime at sujalmeena@lexguard.co.in or open an issue on our GitHub repository. We actively listen to user feedback to improve the product."
  }
];

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggleFAQ = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section id="faq" className="faq-section" style={{ maxWidth: '800px', margin: '0 auto', padding: '140px 24px', position: 'relative', zIndex: 10 }}>
      <motion.h2 
        className="section-title"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        style={{ fontSize: '2.5rem', marginBottom: '60px', textAlign: 'center' }}
      >
        Frequently asked questions
      </motion.h2>

      <div className="faq-container" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {faqs.map((faq, index) => {
          const isOpen = openIndex === index;
          return (
            <motion.div 
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '16px',
                overflow: 'hidden',
                transition: 'background 0.3s ease, border-color 0.3s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
              }}
            >
              <button 
                onClick={() => toggleFAQ(index)}
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '24px',
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  fontSize: '1.1rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <span>{faq.question}</span>
                <motion.div
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: 0.3, ease: 'easeInOut' }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  <ChevronDown size={20} />
                </motion.div>
              </button>

              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                  >
                    <div style={{ 
                      padding: '0 24px 24px', 
                      color: 'rgba(255, 255, 255, 0.65)', 
                      lineHeight: 1.6,
                      fontSize: '0.95rem'
                    }}>
                      {faq.answer}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
