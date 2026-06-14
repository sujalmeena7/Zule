import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useZule } from '../context/ZuleContext';
import { Shield, Zap, Download, Play, Mic, Video, Smile, Wifi, Battery, Compass, LayoutGrid, Settings, Trash, CirclePlay, Square, MessageSquareText, PenTool, Globe, Link, Mail, MessageCircle } from 'lucide-react';
import './LandingPage.css';

export function LandingPage() {
  const { actions } = useZule();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const DOWNLOAD_URL_WIN = 'https://github.com/sujalmeena7/Zule/releases/latest/download/zuleAI-Setup.exe';
  const DOWNLOAD_URL_MAC = 'https://github.com/sujalmeena7/Zule/releases/latest/download/zuleAI-Setup.exe';

  const handleGetStarted = () => {
    actions.navigateTo('dashboard');
  };

  const handleDownload = () => {
    // Detect OS and download appropriate installer
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const url = isMac ? DOWNLOAD_URL_MAC : DOWNLOAD_URL_WIN;
    window.open(url, '_blank');
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.06,
        delayChildren: 0.1
      }
    }
  };

  const wordVariants = {
    hidden: { y: '1.1em', opacity: 0 },
    visible: { 
      y: 0, 
      opacity: 1,
      transition: { 
        duration: 0.7, 
        ease: [0.16, 1, 0.3, 1]
      } 
    }
  };
  return (
    <div className="landing-container">
      <header className="landing-header">
        <motion.div 
          className="landing-logo"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <div className="landing-logo-icon" />
          <span>Zule AI</span>
        </motion.div>
        <motion.nav 
          className="landing-nav"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
        >
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <button className="btn-landing" onClick={handleGetStarted}>Log in</button>
        </motion.nav>
      </header>

      <main className="landing-content">
        <section className="hero-section" style={{ position: 'relative' }}>
          
          {/* Animated Background Orbs */}
          <div className="hero-bg-container">
            <motion.div 
              className="bg-orb primary"
              animate={{ x: [0, 50, 0], y: [0, 30, 0], scale: [1, 1.1, 1] }}
              transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div 
              className="bg-orb secondary"
              animate={{ x: [0, -40, 0], y: [0, -50, 0], scale: [1, 1.2, 1] }}
              transition={{ duration: 18, repeat: Infinity, ease: "easeInOut", delay: 2 }}
            />
            <motion.div 
              className="bg-orb accent"
              animate={{ x: [-20, 20, -20], y: [-20, 20, -20], scale: [1, 1.05, 1] }}
              transition={{ duration: 12, repeat: Infinity, ease: "easeInOut", delay: 4 }}
            />
          </div>

          <motion.div 
            className="hero-badge-glow"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <Zap size={14} color="#3b82f6" />
            Zule 2.0 is now live
          </motion.div>
          
          <motion.h1 
            className="hero-title"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            {["#1", "Undetectable", "AI", "for", "Meetings"].map((word, idx) => (
              <span key={idx} className="hero-title-word-container">
                <motion.span 
                  variants={wordVariants} 
                  className="hero-title-word"
                >
                  {word}
                </motion.span>
              </span>
            ))}
          </motion.h1>

          <motion.hr 
            className="hero-separator"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
          />
          
          <motion.h2 
            className="hero-subtitle"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.5 }}
          >
            Zule takes perfect meeting notes and gives real-time answers, all while completely undetectable
          </motion.h2>
          
          <motion.div 
            className="hero-actions"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.8 }}
          >
            <motion.button 
              className="btn-landing primary large magnetic" 
              onClick={handleDownload}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Download size={18} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'text-bottom' }} />
              Download for Free
            </motion.button>
            <motion.button 
              className="btn-landing large magnetic" 
              onClick={handleGetStarted}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Play size={18} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'text-bottom' }} />
              See how it works
            </motion.button>
          </motion.div>
          
          <motion.div
            className="hero-disclaimer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 1.2 }}
          >
            <Shield size={14} /> 100% private. Never shows up on screen share.
          </motion.div>

        </section>

        {/* --- COMPATIBLE TOOLS TICKER --- */}
        <section className="tools-ticker-section">
          <p className="tools-ticker-label">COMPATIBLE WITH EVERY TOOL</p>
          <div className="tools-ticker-wrapper">
            <div className="tools-ticker-track">
              {[...Array(2)].map((_, setIdx) => (
                <div key={setIdx} className="tools-ticker-set">
                  <div className="ticker-item">Zoom</div>
                  <div className="ticker-item">Slack</div>
                  <div className="ticker-item">Microsoft Teams</div>
                  <div className="ticker-item">Google Meet</div>
                  <div className="ticker-item">Webex</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --- HOW IT WORKS SECTION --- */}
        <section id="how-it-works" className="hiw-section">
          <motion.h2 
            className="section-title"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            How Zule helps during a meeting
          </motion.h2>

          <div className="hiw-grid">
            {/* Card 1: Listens */}
            <motion.div 
              className="hiw-card blue"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <h3>Zule <span className="hiw-badge"><Mic size={18} fill="white"/> listens</span> in to the conversation</h3>
              <p>It picks up the context of your meeting in real time, so it can help when you need it.</p>
              
              <div className="hiw-timer">
                <span className="time">{formatTime(seconds)}</span>
                <span className="status"><span className="red-dot"></span> Recording</span>
              </div>
              
              <div className="hiw-waveform">
                {[...Array(40)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="hiw-bar"
                    animate={{ height: ['10px', `${Math.random() * 40 + 20}px`, '10px'] }}
                    transition={{ duration: Math.random() * 0.5 + 0.5, repeat: Infinity, ease: 'easeInOut' }}
                  />
                ))}
              </div>
              
              {/* Faded Widget Mockup */}
              <div className="hiw-widget-mockup" style={{ opacity: 0.3 }}>
                <div style={{ display: 'flex', gap: '12px', opacity: 0.5, marginBottom: '12px', fontSize: '10px' }}>
                  <span>✨ Assist</span>
                  <span>💬 What should I say?</span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.1)', padding: '12px', borderRadius: '8px', fontSize: '12px' }}>
                  Ask about your screen or conversation...
                </div>
              </div>
            </motion.div>
            
            {/* Card 2: Assists */}
            <motion.div 
              className="hiw-card light"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
            >
              <h3>When you need help, Zule <span className="hiw-badge"><Zap size={18} fill="black" color="black"/> assists</span> you instantly</h3>
              <p>Hit Cmd/Ctrl + Enter and Zule helps you with AI in the moment.</p>
              
              <motion.div 
                style={{ position: 'absolute', bottom: '40px', left: '50%', width: '90%' }}
                initial={{ y: 20, opacity: 0, x: "-50%" }}
                whileInView={{ y: 0, opacity: 1, x: "-50%" }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 }}
              >
                {/* Zule Widget Pill */}
                <div style={{ width: '120px', height: '32px', background: '#333', borderRadius: '16px', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px', color: 'white', fontSize: '12px' }}>
                   <div style={{ width: '24px', height: '24px', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                     <Zap size={12} color="white" />
                   </div>
                   Hide <Square size={10} fill="white" style={{ marginRight: '6px' }}/>
                </div>
                
                {/* Zule Widget Body */}
                <div className="hiw-widget-mockup" style={{ position: 'relative', bottom: '0', width: '100%', background: '#333', borderColor: '#444' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                     <span style={{ background: '#1d4ed8', color: 'white', padding: '4px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600 }}>Assist</span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#ccc', marginBottom: '16px' }}>
                    Viewed screen<br/>
                    <strong style={{ color: 'white' }}>Zule is an AI meeting assistant that listens in real time, understands what's being said, and gives you instant answers...</strong>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', color: '#999', marginBottom: '12px', fontSize: '10px' }}>
                    <span>✨ Assist</span>
                    <span>💬 What should I say?</span>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '12px', borderRadius: '8px', fontSize: '12px', color: '#999', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    Ask about your screen or conversation...
                    <CirclePlay size={16} color="#3b82f6" fill="rgba(59, 130, 246, 0.2)" />
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* --- FEATURES BENTO GRID --- */}
        <section className="features-section">
          <motion.h2 
            className="section-title"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            Everything you need. <br />Nothing you don't.
          </motion.h2>
          <motion.p 
            className="section-subtitle"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            Zule runs silently in the background and gives you superpowers.
          </motion.p>

          <div className="bento-grid">
            {/* Feature 1: Invisible */}
            <motion.div 
              className="bento-card large"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <div className="bento-graphic">
                {/* Animated Graphic for 'Invisible' */}
                <div style={{ position: 'relative', width: '120px', height: '80px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                  <motion.div
                    style={{ position: 'absolute', top: '10px', right: '10px', width: '40px', height: '30px', background: 'rgba(59, 130, 246, 0.8)', borderRadius: '6px', backdropFilter: 'blur(4px)' }}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{ duration: 4, repeat: Infinity, times: [0, 0.5, 1] }}
                  />
                  <motion.div 
                    style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)', width: '200%' }}
                    animate={{ x: ['-100%', '100%'] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                  />
                  <div style={{ position: 'absolute', bottom: '-15px', right: '-15px' }}>
                    <Shield size={48} color="#3b82f6" />
                  </div>
                </div>
              </div>
              <div className="bento-content">
                <h3>Completely Invisible</h3>
                <p>Zule is a native app that runs over your screen. It never joins the meeting as a bot, and is completely invisible to other participants even when you share your screen.</p>
              </div>
            </motion.div>

            {/* Feature 2: Real-time */}
            <motion.div 
              className="bento-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: 0.1 }}
            >
              <div className="bento-graphic">
                <div style={{ position: 'relative', width: '140px', height: '60px', background: 'rgba(255,255,255,0.05)', borderRadius: '30px', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', padding: '0 20px', gap: '8px' }}>
                  <motion.div
                    style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308' }}
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 0.6, repeat: Infinity, delay: 0 }}
                  />
                  <motion.div
                    style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308' }}
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 0.6, repeat: Infinity, delay: 0.15 }}
                  />
                  <motion.div
                    style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308' }}
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 0.6, repeat: Infinity, delay: 0.3 }}
                  />
                  <motion.div style={{ position: 'absolute', right: '-10px', top: '-15px' }} animate={{ rotate: [0, 10, -10, 0] }} transition={{ duration: 2, repeat: Infinity }}>
                    <Zap size={32} color="#eab308" />
                  </motion.div>
                </div>
              </div>
              <div className="bento-content">
                <h3>Real-time Answers</h3>
                <p>Stumped by a question? Zule listens to the conversation and instantly feeds you the perfect response.</p>
              </div>
            </motion.div>

            {/* Feature 3: Auto Notes */}
            <motion.div 
              className="bento-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <div className="bento-graphic">
                <div style={{ position: 'relative', width: '80px', height: '100px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', padding: '16px' }}>
                  {[0, 1, 2, 3].map(i => (
                    <motion.div
                      key={i}
                      style={{ height: '4px', background: i === 0 ? '#8b5cf6' : 'rgba(255,255,255,0.2)', borderRadius: '2px', marginBottom: '12px' }}
                      initial={{ width: 0 }}
                      animate={{ width: i === 0 ? '60%' : ['0%', '100%', '80%'] }}
                      transition={{ duration: 2, repeat: Infinity, repeatType: 'reverse', delay: i * 0.2 }}
                    />
                  ))}
                </div>
              </div>
              <div className="bento-content">
                <h3>Autopilot Notes</h3>
                <p>Zule automatically generates summaries, action items, and follow-up emails the second your meeting ends.</p>
              </div>
            </motion.div>

            {/* Feature 4: Works Everywhere */}
            <motion.div 
              className="bento-card large"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
            >
              <div className="bento-graphic">
                <div style={{ display: 'flex', gap: '30px' }}>
                  <Video size={40} color="#60a5fa" />
                  <Mic size={40} color="#a78bfa" />
                  <Smile size={40} color="#34d399" />
                </div>
              </div>
              <div className="bento-content">
                <h3>Works with everything</h3>
                <p>Zoom, Google Meet, Teams, Webex. If it uses your microphone, Zule can hear it. No integrations or bot invites required.</p>
              </div>
            </motion.div>

          </div>
        </section>

        {/* --- BOTTOM CTA --- */}
        <section className="bottom-cta-section">
          <div className="bottom-cta-content">
            <motion.h2 
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              Meeting AI that helps during the call, not after.
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
            >
              Try Zule on your next meeting today.
            </motion.p>
            <motion.button 
              className="btn-windows"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleDownload}
            >
              <LayoutGrid size={18} fill="white" /> Download for Windows
            </motion.button>
          </div>
          
          {/* Decorative floating keycaps */}
          <motion.div 
            className="floating-keycap right"
            animate={{ y: [-10, 10, -10], rotate: [-2, 2, -2] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          >
            <Compass size={32} color="#a1a1aa" />
          </motion.div>
          <motion.div 
            className="floating-keycap left"
            animate={{ y: [10, -10, 10], rotate: [2, -2, 2] }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          >
            <Zap size={32} color="#a1a1aa" />
          </motion.div>
        </section>

        {/* --- FOOTER --- */}
        <footer className="zule-footer">
          <div className="footer-top">
            <div className="footer-brand">
              <div className="footer-logo">
                <div className="footer-logo-icon">
                </div>
                Zule
              </div>
            </div>
            
            <div className="footer-links-grid">
              <div className="footer-column">
                <h4>Resources</h4>
                <a href="#">Mobile <span className="badge-new">New</span></a>
                <a href="#">Manifesto</a>
                <a href="#">Press</a>
                <a href="#">Bug Bounty</a>
              </div>
              <div className="footer-column">
                <h4>Support</h4>
                <a href="#">Help Center</a>
                <a href="#">Contact Us</a>
              </div>
              <div className="footer-column">
                <h4>Legal</h4>
                <a href="#">Privacy Policy</a>
                <a href="#">Terms of Service</a>
                <a href="#">Subprocessors</a>
              </div>
            </div>
          </div>

          <div className="footer-status-row">
            <div className="status-badge">
              <div className="status-dot"></div> All systems operational
            </div>
          </div>
          <div className="footer-sub-row">
            List of <a href="#" style={{ color: '#3b82f6', textDecoration: 'none', marginLeft: '4px' }}>subprocessors</a>.
          </div>

          <div className="footer-bottom">
            <div className="footer-copyright">
              © 2026 Zule AI. All rights reserved.
            </div>
            <div className="footer-socials">
              <a href="#"><Globe size={18} /></a>
              <a href="#"><MessageCircle size={18} /></a>
              <a href="#"><Mail size={18} /></a>
              <a href="#"><Link size={18} /></a>
            </div>
          </div>
        </footer>

      </main>
    </div>
  );
}
