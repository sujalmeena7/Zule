import { motion } from 'framer-motion';
import { useZule } from '../context/ZuleContext';
import { ArrowRight } from 'lucide-react';
import { blogPosts } from '../data/blogPosts';
import './BlogPage.css';

export function BlogPage() {
  const { actions } = useZule();

  return (
    <div className="blog-container">
      {/* Header / Nav */}
      <div className="landing-header-wrapper">
        <header className="landing-header">
          <motion.div 
            className="landing-logo"
            style={{ cursor: 'pointer' }}
            onClick={() => actions.navigateTo('landing')}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <img src="/favicon.svg" alt="Zule logo" className="landing-logo-icon" />
            <span>Zule AI</span>
          </motion.div>
          <motion.nav 
            className="landing-nav"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="landing-nav-links">
              <a href="#" onClick={(e) => { e.preventDefault(); actions.navigateTo('landing'); }}>Home</a>
            </div>
            <button className="nav-cta" onClick={() => window.open('https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe', '_blank')}>Get Zule</button>
          </motion.nav>
        </header>
      </div>

      <section className="blog-header">
        <motion.h1 
          className="blog-title"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Insights & Guides
        </motion.h1>
        <motion.p 
          className="blog-subtitle"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          Deep dives into AI meeting assistants, productivity, and the future of work.
        </motion.p>
      </section>

      <section className="blog-grid">
        {blogPosts.map((post, idx) => (
          <motion.div 
            key={post.slug}
            className="blog-card"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + (idx * 0.1) }}
            onClick={() => actions.viewBlogPost(post.slug)}
          >
            <div className="blog-meta">
              <span className="blog-category">{post.category}</span>
              <span>{post.readTime}</span>
            </div>
            <h3>{post.title}</h3>
            <p>{post.excerpt}</p>
            <div className="blog-read-more">
              Read Article <ArrowRight size={16} />
            </div>
          </motion.div>
        ))}
      </section>
    </div>
  );
}
