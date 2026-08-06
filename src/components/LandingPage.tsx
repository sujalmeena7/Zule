import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { motion, MotionConfig } from 'framer-motion';
import { useZule } from '../context/ZuleContext';
import { Shield, Zap, Download, Play, Mic, Video, Smile, CirclePlay, Square, Globe, Mail, MessageCircle, Check } from 'lucide-react';
import { FAQSection } from './FAQSection';
import { AnimatedMockup } from './AnimatedMockup';
import { ErrorBoundary } from './ErrorBoundary';
import {
  LandingMotionProvider,
  useLandingMotion,
} from './landing/LandingMotionContext';
import {
  FloatingNavbar,
  type FloatingNavbarAnchorId,
} from './landing/FloatingNavbar';
import { TiltCard } from './landing/TiltCard';
import { ParallaxLayer } from './landing/ParallaxLayer';
import './LandingPage.css';
import './landing/landing-3d.css';

// Lazy-load the WebGL hero so `three` / `@react-three/fiber` /
// `@react-three/drei` are pulled into the `vendor-three` async chunk
// and never enter the initial landing route bundle (Req 2.6, 11.3).
const Hero3DCanvas = lazy(() => import('./landing/Hero3DCanvas'));

/**
 * Outer entry point. Owns the `LandingMotionProvider` so every
 * descendant — including {@link LandingPageContent} — can read the
 * shared motion flags (`webglAvailable`, `dprCap`, `reducedMotion`,
 * `tabVisible`, `lowEndGpu`) via `useLandingMotion()`.
 *
 * Requirements: 2.4, 2.5, 9.1, 9.2
 */
export function LandingPage() {
  return (
    <LandingMotionProvider>
      <LandingPageContent />
    </LandingMotionProvider>
  );
}

/**
 * Inner landing-page body. Must be rendered inside
 * {@link LandingMotionProvider} so the `useLandingMotion()` call below
 * resolves.
 */
function LandingPageContent() {
  const { webglAvailable, dprCap } = useLandingMotion();
  const { actions } = useZule();
  const [seconds, setSeconds] = useState(0);
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');

  /*
    Ref to the hero `<section>` so `FloatingNavbar`'s `useScroll`
    can compute the compaction trigger relative to the hero's
    bottom edge (Req 3.3, 3.4). Typed as `HTMLElement` because the
    underlying DOM node is a `<section>`, matching the
    `RefObject<HTMLElement | null>` shape the navbar's
    `heroBottomRef` prop expects.
  */
  const heroSectionRef = useRef<HTMLElement | null>(null);

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

  const DOWNLOAD_URL_WIN = 'https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe';
  const DOWNLOAD_URL_MAC = 'https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe';

  const handleGetStarted = () => {
    actions.navigateTo('dashboard');
  };

  const handleDownload = () => {
    // Detect OS and download appropriate installer
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const url = isMac ? DOWNLOAD_URL_MAC : DOWNLOAD_URL_WIN;
    window.open(url, '_blank');
  };

  /*
    Blog navigation handler for the floating navbar. Delegates to the
    existing `actions.navigateTo('blog')` flow so the redesign reuses
    the routing the legacy header already used (Req 8.4).
  */
  const handleBlog = useCallback(() => {
    actions.navigateTo('blog');
  }, [actions]);

  /*
    Smooth-scroll handler for the three anchor entries in the
    floating navbar — `Features`, `How it works`, and `FAQ`. The
    legacy `<a href="#features">` tags relied on the browser's native
    anchor jump; the new navbar fires synthetic clicks (preventing
    default) and delegates the scroll back here so we can route every
    target through one place and degrade gracefully when the section
    has not yet mounted (Req 8.5).
  */
  const handleAnchor = useCallback((id: FloatingNavbarAnchorId) => {
    if (typeof document === 'undefined') return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
        ease: [0.16, 1, 0.3, 1] as [number, number, number, number]
      }
    }
  };
  return (
    <div className="landing-container">
      {/*
        Floating glassmorphic navbar — replaces the legacy
        `.landing-header` + `<nav>` block. Routing, download, and
        anchor-scroll wiring all reuse the same handlers the legacy
        header used so behaviour stays identical for visitors
        (Req 3.6, 8.2, 8.3, 8.4, 8.5). `heroSectionRef` is forwarded
        as the `heroBottomRef` source so `useScroll` inside the navbar
        can compute the compaction trigger relative to the hero's
        bottom edge (Req 3.3, 3.4, 7.1-7.5).
      */}
      <FloatingNavbar
        heroBottomRef={heroSectionRef}
        onDownload={handleDownload}
        onBlog={handleBlog}
        onAnchor={handleAnchor}
      />

      <main className="landing-content">
        <section
          ref={heroSectionRef}
          className="hero-section"
          style={{ position: 'relative' }}
        >

          {/*
            Lazy WebGL hero. Mounted only when a WebGL context can be
            created (Req 2.5, 9.2); wrapped in ErrorBoundary so a runtime
            WebGL failure never crashes the page (Req 9.1) and in
            Suspense so the page renders immediately while the
            `vendor-three` chunk streams in (Req 1.1, 1.5, 1.6, 11.3).
          */}
          {webglAvailable && (
            <ErrorBoundary fallback={<></>}>
              <Suspense fallback={null}>
                <Hero3DCanvas dprCap={dprCap} />
              </Suspense>
            </ErrorBoundary>
          )}

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
            <img src="./favicon.svg" alt="Zule" style={{ width: 14, height: 14 }} />
            Zule 1.3.0 is now live
          </motion.div>

          {/* SEO Visually Hidden H2 for Competitor Keyword Ranking */}
          <h2 style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
            Looking for a Cluely alternative? Zule is the ultimate undetectable AI meeting assistant for real-time answers.
          </h2>

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
              Download for Windows
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
            <MotionConfig reducedMotion="never">
              <motion.div 
                className="tools-ticker-track"
                animate={{ x: ["0%", "-25%"] }}
                transition={{ duration: 15, ease: "linear", repeat: Infinity }}
              >
                {[...Array(4)].map((_, setIdx) => (
                  <div key={setIdx} className="tools-ticker-set">
                    <div className="ticker-item">Zoom</div>
                    <div className="ticker-dot" />
                    <div className="ticker-item">Slack</div>
                    <div className="ticker-dot" />
                    <div className="ticker-item">Microsoft Teams</div>
                    <div className="ticker-dot" />
                    <div className="ticker-item">Google Meet</div>
                    <div className="ticker-dot" />
                    <div className="ticker-item">Webex</div>
                    <div className="ticker-dot" />
                  </div>
                ))}
              </motion.div>
            </MotionConfig>
          </div>
        </section>

        {/* --- LIVE INTELLIGENCE STATS SECTION --- */}
        <section className="stats-section">
          <div className="stats-layout">
            {/*
              Left: Zule overlay mockup showing what the app actually
              does (Now Animated). Wrapped in `ParallaxLayer` so the
              mockup gains a bounded scroll-driven Y parallax (±20 px,
              40 px total swing) as the stats section passes through
              the viewport. `ParallaxLayer` short-circuits to a plain
              `<div>` under reduced motion so the visual baseline is
              preserved (Req 6.3, 6.5, 10.3).
            */}
            <ParallaxLayer maxPx={20}>
              <AnimatedMockup />
            </ParallaxLayer>

            {/* Right: Stats with animated numbers */}
            <div className="stats-right">
              <motion.h2
                className="stats-heading"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
              >
                Live conversation intelligence
              </motion.h2>

              <div className="stats-grid">
                <motion.div
                  className="stat-row"
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.1 }}
                >
                  <div className="stat-number">12+</div>
                  <div className="stat-info">
                    <h4>Languages</h4>
                    <p>Supports English, Hindi, Spanish, French, German, Japanese, and more — all processed in real time.</p>
                  </div>
                </motion.div>

                <motion.div
                  className="stat-row"
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.25 }}
                >
                  <div className="stat-number">200ms</div>
                  <div className="stat-info">
                    <h4>AI response latency</h4>
                    <p>Instant suggestions appear before the speaker finishes. Built for the speed of live conversation.</p>
                  </div>
                </motion.div>

                <motion.div
                  className="stat-row"
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.4 }}
                >
                  <div className="stat-number">100%</div>
                  <div className="stat-info">
                    <h4>Invisible to participants</h4>
                    <p>OS-level stealth ensures no one on the call, recording, or screen share can ever detect Zule.</p>
                  </div>
                </motion.div>
              </div>
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
        <section id="features" className="features-section">
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

          {/*
            Bento grid — `.bento-grid` is the perspective-anchor class
            that `landing-3d.css` uses to give each `.bento-card`
            inside a shared 3D perspective. Each card is wrapped in
            `TiltCard` so the existing card markup gains a subtle
            pointer-driven tilt (±8°, 250 ms ease-out) while keeping
            its existing `.bento-card` class intact. `TiltCard`
            short-circuits to neutral under reduced motion
            (Req 6.1, 6.2, 6.4, 6.5, 10.3).
          */}
          <div className="bento-grid">
            {/* Feature 1: Invisible */}
            <TiltCard>
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
            </TiltCard>

            {/* Feature 2: Real-time */}
            <TiltCard>
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
            </TiltCard>

            {/* Feature 3: Auto Notes */}
            <TiltCard>
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
                        style={{ height: '4px', background: i === 0 ? '#3b82f6' : 'rgba(255,255,255,0.2)', borderRadius: '2px', marginBottom: '12px' }}
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
            </TiltCard>

            {/* Feature 4: Works Everywhere */}
            <TiltCard>
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
                    <Mic size={40} color="#94a3b8" />
                    <Smile size={40} color="#34d399" />
                  </div>
                </div>
                <div className="bento-content">
                  <h3>Works with everything</h3>
                  <p>Zoom, Google Meet, Teams, Webex. If it uses your microphone, Zule can hear it. No integrations or bot invites required.</p>
                </div>
              </motion.div>
            </TiltCard>

          </div>
        </section>

        {/* --- PRICING SECTION --- */}
        <section id="pricing" className="pricing-section" style={{ padding: '100px 20px', maxWidth: '1200px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '60px' }}>
            <motion.h2
              className="section-title"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              Unfair advantage, <span className="gradient-text">fair price</span>
            </motion.h2>
            <motion.p
              className="section-subtitle"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              style={{ maxWidth: '600px', margin: '0 auto' }}
            >
              Why pay $40/mo for Cluely? Get a faster, stealthier, and more powerful copilot for a fraction of the cost.
            </motion.p>

            {/* Billing Toggle */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginTop: '40px', gap: '15px' }}>
              <span style={{ color: billingInterval === 'monthly' ? '#fff' : 'var(--text-secondary)', fontWeight: 500, transition: 'color 0.2s' }}>Monthly</span>
              <button
                onClick={() => setBillingInterval(prev => prev === 'monthly' ? 'annual' : 'monthly')}
                style={{
                  width: '60px', height: '32px', borderRadius: '20px', background: 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.1)', position: 'relative', cursor: 'pointer', outline: 'none'
                }}
              >
                <div style={{
                  width: '24px', height: '24px', borderRadius: '50%', background: '#3b82f6',
                  position: 'absolute', top: '3px', left: billingInterval === 'monthly' ? '3px' : '31px',
                  transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                }} />
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: billingInterval === 'annual' ? '#fff' : 'var(--text-secondary)', fontWeight: 500, transition: 'color 0.2s' }}>Yearly</span>
                <span style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', fontWeight: 'bold', border: '1px solid rgba(59, 130, 246, 0.3)' }}>Save 20%</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '30px', alignItems: 'stretch' }}>
            {/* Free Tier */}
            <motion.div
              className="bento-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Free</h3>
              <div style={{ fontSize: '2.5rem', fontWeight: 'bold', marginBottom: '8px' }}>$0<span style={{ fontSize: '1rem', color: 'var(--text-tertiary)', fontWeight: 'normal' }}>/mo</span></div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '0.9rem' }}>Perfect for trying out the stealth copilot.</p>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 30px 0', flex: 1 }}>
                {['Stealth overlay (undetectable!)', '3 meetings/day (30 min each)', '20 AI responses/day', 'Assist & Recap modes', '3 Knowledge Base documents'].map((feat, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Check size={10} color="#fff" />
                    </div>
                    {feat}
                  </li>
                ))}
              </ul>
              <button className="btn-secondary" onClick={handleDownload} style={{ width: '100%', justifyContent: 'center' }}>Download Free</button>
            </motion.div>

            {/* Pro Tier (Highlighted) */}
            <motion.div
              className="bento-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              style={{ display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.1) 0%, rgba(255, 255, 255, 0.02) 100%)', borderColor: 'rgba(37, 99, 235, 0.4)', position: 'relative' }}
            >
              <div style={{ position: 'absolute', top: '-12px', left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)', color: 'white', padding: '4px 16px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)' }}>
                MOST POPULAR
              </div>
              <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Pro</h3>
              <div style={{ fontSize: '2.5rem', fontWeight: 'bold', marginBottom: '8px' }}>
                {billingInterval === 'monthly' ? '₹1,499' : '₹14,990'}
                <span style={{ fontSize: '1rem', color: 'var(--text-tertiary)', fontWeight: 'normal' }}>
                  {billingInterval === 'monthly' ? '/mo' : '/yr'}
                </span>
              </div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '0.9rem' }}>Everything you need to ace every meeting.</p>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 30px 0', flex: 1 }}>
                {['Unlimited meetings & duration', 'Unlimited AI responses', 'All 7 copilot modes', '50 Knowledge Base documents', 'Export transcripts & analytics'].map((feat, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', fontSize: '0.9rem', color: 'white' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Check size={10} color="#fff" />
                    </div>
                    {feat}
                  </li>
                ))}
              </ul>
              <button className="btn-primary" onClick={handleDownload} style={{ width: '100%', justifyContent: 'center' }}>Upgrade to Pro</button>
            </motion.div>

            {/* Ultra Tier */}
            <motion.div
              className="bento-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Ultra</h3>
              <div style={{ fontSize: '2.5rem', fontWeight: 'bold', marginBottom: '8px' }}>
                {billingInterval === 'monthly' ? '₹2,499' : '₹24,990'}
                <span style={{ fontSize: '1rem', color: 'var(--text-tertiary)', fontWeight: 'normal' }}>
                  {billingInterval === 'monthly' ? '/mo' : '/yr'}
                </span>
              </div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '0.9rem' }}>For power users and professionals.</p>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 30px 0', flex: 1 }}>
                {['Everything in Pro', 'Unlimited Knowledge Base', 'Unlimited custom modes', 'Multi-language transcription', 'Real-time translation', 'Local Ollama model support'].map((feat, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Check size={10} color="#fff" />
                    </div>
                    {feat}
                  </li>
                ))}
              </ul>
              <button className="btn-secondary" onClick={handleDownload} style={{ width: '100%', justifyContent: 'center' }}>Get Ultra</button>
            </motion.div>
          </div>
        </section>

        {/* --- FAQ SECTION --- */}
        <FAQSection />

        {/* --- BOTTOM CTA --- */}
        <section id="download" className="bottom-cta-section">
          <div className="bottom-cta-content">
            <motion.div
              className="cta-badge"
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
            >
              🚀 Ready to upgrade your meetings?
            </motion.div>
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              Your AI advantage starts now.
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
            >
              Download Zule and never feel unprepared in a meeting again.
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
              <Download size={18} /> Download for Windows
            </motion.button>
            <motion.span
              className="cta-note"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.4 }}
            >
              Free forever • No credit card • 2-minute setup
            </motion.span>
          </div>
        </section>

        {/* --- FOOTER --- */}
        <footer className="zule-footer">
          <div className="footer-top">
            <div className="footer-brand">
              <div className="footer-logo">
                <img src="./favicon.svg" alt="Zule Logo" className="footer-logo-icon" style={{ width: '24px', height: '24px' }} />
                Zule
              </div>
            </div>

            <div className="footer-links-grid">
              <div className="footer-column">
                <h4>Product</h4>
                <a href="#features">Features</a>
                <a href="#download">Download</a>
                <a href="https://github.com/sujalmeena7/Zule/releases" target="_blank" rel="noreferrer">Changelog</a>
              </div>
              <div className="footer-column">
                <h4>Support</h4>
                <a href="https://github.com/sujalmeena7/Zule/discussions" target="_blank" rel="noreferrer">Help Center</a>
                <a href="mailto:sujalmeena@lexguard.co.in">Contact Us</a>
                <a href="https://github.com/sujalmeena7/Zule/issues" target="_blank" rel="noreferrer">Bug Report</a>
              </div>
              <div className="footer-column">
                <h4>Legal</h4>
                <a href="#privacy">Privacy Policy</a>
                <a href="#terms">Terms of Service</a>
              </div>
            </div>
          </div>

          <div className="footer-bottom">
            <div className="footer-copyright">
              © 2025 Zule AI. All rights reserved.
            </div>
            <div className="footer-socials">
              <a href="https://github.com/sujalmeena7/Zule" target="_blank" rel="noreferrer" title="Github"><Globe size={18} /></a>
              <a href="https://github.com/sujalmeena7/Zule/discussions" target="_blank" rel="noreferrer" title="Discussions"><MessageCircle size={18} /></a>
              <a href="mailto:sujalmeena@lexguard.co.in" title="Email"><Mail size={18} /></a>
            </div>
          </div>
        </footer>

      </main>
    </div>
  );
}
