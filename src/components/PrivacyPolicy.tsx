import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';

export function PrivacyPolicy() {
  return (
    <div style={{ minHeight: '100vh', background: '#0a0a12', color: '#f1f1f7', padding: '40px 24px', fontFamily: '"Inter", sans-serif' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <button 
          onClick={() => window.location.hash = ''}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '40px', fontSize: '1rem' }}
        >
          <ArrowLeft size={18} /> Back to Zule
        </button>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, marginBottom: '24px', fontFamily: '"Outfit", sans-serif' }}>Privacy Policy</h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: '40px' }}>Last Updated: {new Date().toLocaleDateString()}</p>

          <div style={{ lineHeight: 1.7, color: 'rgba(255,255,255,0.85)', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <p>At Zule AI, we take your privacy seriously. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our desktop application and website.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>1. Local Processing First</h2>
            <p>Zule AI is designed to prioritize your privacy. We process meeting audio and generate summaries directly on your device whenever possible. We do not store your meeting transcripts or audio recordings on our servers unless explicitly required for syncing across devices (and only if you opt-in).</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>2. Information We Collect</h2>
            <p><strong>Account Information:</strong> We collect your email address and basic profile information when you create an account to use our services.</p>
            <p><strong>Usage Data:</strong> We may collect anonymous diagnostic and usage data to improve application performance. This does not include the content of your meetings.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>3. How We Use Your Information</h2>
            <p>We use the information we collect to operate, maintain, and provide the features of Zule AI. We also use it to communicate with you about updates, security alerts, and support messages.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>4. Data Security</h2>
            <p>We implement commercially reasonable technical and organizational measures to protect your personal data against unauthorized access. However, no security system is impenetrable, and we cannot guarantee absolute security.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>5. Third-Party Services</h2>
            <p>Zule may integrate with third-party LLM providers (like OpenAI or Anthropic) to power advanced summarization. When using cloud-based models, transcript snippets are sent over secure connections, processed, and not used to train their models.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>6. Contact Us</h2>
            <p>If you have questions or comments about this Privacy Policy, please contact us at support@zule.ai.</p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
