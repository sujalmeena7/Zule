import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';

export function TermsOfService() {
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
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, marginBottom: '24px', fontFamily: '"Outfit", sans-serif' }}>Terms of Service</h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: '40px' }}>Last Updated: {new Date().toLocaleDateString()}</p>

          <div style={{ lineHeight: 1.7, color: 'rgba(255,255,255,0.85)', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <p>Please read these Terms of Service completely using zule.ai which is owned and operated by Zule AI.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>1. Acceptance of Terms</h2>
            <p>By downloading, installing, or using the Zule AI application ("Software"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Software.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>2. Description of Service</h2>
            <p>Zule AI is a desktop application designed to transcribe, summarize, and assist users during online meetings. It captures audio output and microphone input on your local machine to provide these services.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>3. User Responsibilities & Compliance</h2>
            <p><strong>Consent to Record:</strong> You are solely responsible for ensuring you comply with all local, state, and federal laws regarding the recording of conversations and meetings. Many jurisdictions require two-party consent to record audio. You must notify other participants that the meeting is being transcribed or recorded when legally required.</p>
            <p>Zule AI is not responsible for any legal liability arising from your failure to obtain necessary consent from meeting participants.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>4. Intellectual Property</h2>
            <p>The Software and its original content, features, and functionality are owned by Zule AI and are protected by international copyright, trademark, patent, trade secret, and other intellectual property or proprietary rights laws.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>5. Disclaimer of Warranties</h2>
            <p>Your use of the Software is at your sole risk. The Software is provided on an "AS IS" and "AS AVAILABLE" basis. Zule AI expressly disclaims all warranties of any kind, whether express or implied, including, but not limited to the implied warranties of merchantability, fitness for a particular purpose and non-infringement.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>6. Limitation of Liability</h2>
            <p>In no event shall Zule AI, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Software.</p>

            <h2 style={{ color: '#fff', fontSize: '1.5rem', marginTop: '16px' }}>7. Changes to Terms</h2>
            <p>We reserve the right, at our sole discretion, to modify or replace these Terms at any time. What constitutes a material change will be determined at our sole discretion.</p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
