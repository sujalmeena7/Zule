/** Japanese (ja) dictionary. */
const ja: Record<string, string> = {
  // App
  'app.title': 'Zule',
  'app.tagline': 'AI会議コパイロット',

  // Copilot session
  'copilot.start': 'セッション開始',
  'copilot.stop': '停止',
  'copilot.resume': '再開',
  'copilot.listening': '聞いています…',

  // Settings
  'settings.title': '設定',
  'settings.apiKey': 'APIキー',
  'settings.theme': 'テーマ',
  'settings.theme.dark': 'ダーク',
  'settings.theme.light': 'ライト',
  'settings.privacy': 'プライバシーとデータ',
  'settings.language': '言語',
  'settings.provider': 'AIプロバイダー',

  // Knowledge Base
  'kb.title': 'ナレッジベース',
  'kb.addDoc': 'ドキュメントを追加',
  'kb.search': '検索',
  'kb.empty': 'まだドキュメントがありません',

  // Actions
  'action.copy': 'コピー',
  'action.save': '保存',
  'action.cancel': 'キャンセル',
  'action.delete': '削除',
  'action.retry': 'リトライ',
  'action.close': '閉じる',

  // Meetings
  'meeting.summary': '要約',
  'meeting.actions': 'アクションアイテム',
  'meeting.transcript': '議事録',
  'meeting.detail': '会議の詳細',

  // Toasts and errors
  'toast.success': '成功',
  'toast.error': 'エラー',
  'error.micDenied': 'マイクへのアクセスが拒否されました',
  'error.networkFailed': 'ネットワークリクエストに失敗しました',
  'error.unsupported': 'このブラウザではサポートされていない機能です',

  // Coaching
  'coaching.pace': 'ペース',
  'coaching.fillers': 'フィラー',
  'coaching.confidence': '信頼度',
};

export default ja;
