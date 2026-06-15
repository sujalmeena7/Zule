<div align="center">
  <img src="public/favicon.svg" alt="Zule Logo" width="120" height="120" />
  <h1>Zule AI</h1>
  <p><strong>Your Undetectable, Local-First AI Meeting Assistant</strong></p>
  <p>
    <a href="https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe">
      <img src="https://img.shields.io/badge/Download-Windows-blue?style=for-the-badge&logo=windows" alt="Download Windows" />
    </a>
  </p>
</div>

<br />

**Zule AI** is a native desktop application that sits silently in the background, transcribing and summarizing your meetings in real-time. Unlike traditional AI bots, Zule captures system audio directly and never joins your calls as a participant, ensuring complete privacy and an undetectable presence.

---

## 🚀 Features

- 🕵️ **Invisible Presence:** Runs locally on your machine. No awkward bots joining your Zoom, Teams, or Meet rooms.
- 🔒 **Local-First Privacy:** Your meeting audio is captured and processed natively. We do not store your recordings or use them to train our models.
- 💬 **Floating Copilot:** Get real-time transcripts, AI summaries, and actionable insights in a sleek, always-on-top transparent overlay.
- 🌐 **Universal Compatibility:** Works seamlessly with any platform that outputs audio—Zoom, Google Meet, Microsoft Teams, Slack Huddles, and Webex.
- ⚡ **Smart Summarization:** Instantly generates meeting minutes, action items, and key takeaways using advanced LLMs.
- 📄 **Contextual Document Chat:** Import PDFs, DOCX files, and images to chat with your documents alongside your meeting contexts.

## 🛠️ Tech Stack

This project is built with modern web and desktop technologies to ensure high performance and a buttery-smooth user experience.

- **Frontend:** React 19, TypeScript, Vite
- **Desktop Environment:** Electron
- **Styling & Animation:** Vanilla CSS, Framer Motion
- **AI & Processing:** `@huggingface/transformers` (local inference), `tesseract.js` (OCR), `pdfjs-dist` & `mammoth` (document parsing)
- **Backend & Auth:** Firebase

## 📦 Installation & Setup

### For Users

Ready to upgrade your meetings? Download the latest Windows installer directly from our releases page:
👉 **[Download Zule AI Setup (.exe)](https://github.com/sujalmeena7/Zule/releases/latest/download/ZuleAI-setup.exe)**

### For Developers

Want to hack on Zule AI? Follow these steps to get your local environment running.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/sujalmeena7/Zule.git
   cd Zule
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run in Development Mode:**
   ```bash
   npm run electron:dev
   ```

4. **Build the Production Executable:**
   ```bash
   npm run electron:build
   ```
   *Note: If you encounter an `EPERM` error during the build on Windows, temporarily pause your Antivirus real-time protection or exclude the `release/` folder.*

## 🔒 Privacy & Compliance

Zule AI prioritizes your privacy by keeping audio processing local whenever possible. 

**Important:** You are solely responsible for ensuring you comply with all local, state, and federal laws regarding the recording of conversations and meetings. Many jurisdictions require two-party consent to record audio. You must notify other participants that the meeting is being transcribed when legally required.

## 🤝 Support & Feedback

If you encounter any bugs, have feature requests, or just want to say hi, feel free to:
- Open an issue on our [GitHub Issues page](https://github.com/sujalmeena7/Zule/issues)
- Start a discussion on [GitHub Discussions](https://github.com/sujalmeena7/Zule/discussions)
- Email us directly at `sujalmeena@lexguard.co.in`

---

<div align="center">
  <p>© 2025 Zule AI. All rights reserved.</p>
</div>
