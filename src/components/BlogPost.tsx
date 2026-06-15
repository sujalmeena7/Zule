import { motion } from 'framer-motion';
import { useZule } from '../context/ZuleContext';
import { blogPosts } from '../data/blogPosts';
import { Calendar, Clock, User, Download, ArrowLeft } from 'lucide-react';
import React from 'react';
import './BlogPost.css';

// A very simple regex-based markdown parser since we don't have a library
function parseMarkdown(content: string) {
  return content.split('\n').map((line, idx) => {
    if (!line.trim()) return <br key={idx} />;
    
    // Headers
    if (line.startsWith('## ')) {
      return <h2 key={idx}>{line.substring(3)}</h2>;
    }
    if (line.startsWith('# ')) {
      return <h1 key={idx}>{line.substring(2)}</h1>;
    }

    // Bold text and links (simplified)
    let parsedLine = line;
    const parts = [];
    let keyCount = 0;
    
    // Quick regex to split by bold (**text**) and links ([text](url)) and code (`text`)
    const regex = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`)/g;
    let lastIndex = 0;
    
    let match;
    while ((match = regex.exec(parsedLine)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<span key={keyCount++}>{parsedLine.substring(lastIndex, match.index)}</span>);
      }
      
      const token = match[0];
      if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(<strong key={keyCount++}>{token.substring(2, token.length - 2)}</strong>);
      } else if (token.startsWith('[') && token.includes('](')) {
        const text = token.substring(1, token.indexOf(']'));
        const url = token.substring(token.indexOf('(') + 1, token.length - 1);
        parts.push(<a key={keyCount++} href={url}>{text}</a>);
      } else if (token.startsWith('\`') && token.endsWith('\`')) {
        parts.push(<code key={keyCount++}>{token.substring(1, token.length - 1)}</code>);
      }
      
      lastIndex = regex.lastIndex;
    }
    
    if (lastIndex < parsedLine.length) {
      parts.push(<span key={keyCount++}>{parsedLine.substring(lastIndex)}</span>);
    }

    return <p key={idx}>{parts.length > 0 ? parts : parsedLine}</p>;
  });
}

export function BlogPost() {
  const { state, actions } = useZule();
  const post = blogPosts.find(p => p.slug === state.activeBlogPost);

  if (!post) {
    return (
      <div className="post-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <h2>Post not found</h2>
        <button onClick={() => actions.navigateTo('blog')}>Back to Blog</button>
      </div>
    );
  }

  const DOWNLOAD_URL_WIN = 'https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe';
  const handleDownload = () => window.open(DOWNLOAD_URL_WIN, '_blank');

  return (
    <div className="post-container">
      {/* Header / Nav */}
      <div className="landing-header-wrapper">
        <header className="landing-header">
          <motion.div 
            className="landing-logo"
            style={{ cursor: 'pointer' }}
            onClick={() => actions.navigateTo('landing')}
          >
            <img src="/favicon.svg" alt="Zule logo" className="landing-logo-icon" />
            <span>Zule AI</span>
          </motion.div>
          <nav className="landing-nav">
            <div className="landing-nav-links">
              <a href="#" onClick={(e) => { e.preventDefault(); actions.navigateTo('blog'); }}>
                <ArrowLeft size={16} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'text-bottom' }} />
                Back to Blog
              </a>
            </div>
            <button className="nav-cta" onClick={handleDownload}>Get Zule</button>
          </nav>
        </header>
      </div>

      <article>
        <header className="post-header">
          <motion.div 
            className="blog-category" 
            style={{ display: 'inline-block', marginBottom: '24px' }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {post.category}
          </motion.div>
          <motion.h1 
            className="post-title"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            {post.title}
          </motion.h1>
          <motion.div 
            className="post-meta-details"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <span><Calendar size={16} /> {post.date}</span>
            <span><Clock size={16} /> {post.readTime}</span>
            <span><User size={16} /> {post.author}</span>
          </motion.div>
        </header>

        <motion.div 
          className="post-content"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          {parseMarkdown(post.content)}
        </motion.div>
      </article>

      <motion.div 
        className="post-footer"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
      >
        <h3>Ready to upgrade your meetings?</h3>
        <p>Get the undetectable AI assistant that runs entirely on your machine.</p>
        <button 
          className="btn-windows" 
          onClick={handleDownload}
          style={{ padding: '16px 32px', fontSize: '1.1rem', borderRadius: '12px', background: '#3b82f6', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '8px' }}
        >
          <Download size={20} /> Download for Windows
        </button>
      </motion.div>
    </div>
  );
}
