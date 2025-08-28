import React, { useState } from 'react';

function resolveApiBaseUrl(): string {
  const override = (window as any)._API_URL || process.env.REACT_APP_API_URL;
  if (override) return override as string;
  const isHttps = window.location.protocol === 'https:';
  const httpProto = isHttps ? 'https' : 'http';
  if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '3000') {
    return `${httpProto}://localhost:8000`;
  }
  // For single deployment, use relative API URL
  return `${httpProto}://${window.location.host}/api`;
}

const ResetPasswordPage: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    if (!token) {
      setError('Missing or invalid reset link.');
      return;
    }
    try {
      setLoading(true);
      const apiBase = resolveApiBaseUrl();
      const res = await fetch(`${apiBase}/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to reset password');
      }
      setSuccess('Password reset successful. Redirecting to sign in...');
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch (err: any) {
      setError(err?.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-blue-200 via-white to-blue-200 dark:from-black dark:via-neutral-950 dark:to-black text-gray-900 dark:text-white p-6">
      <div className="w-full max-w-md bg-white/80 dark:bg-neutral-900/80 backdrop-blur border border-gray-200 dark:border-blue-900/50 rounded-xl p-5 shadow-xl">
        <div className="text-xl font-semibold mb-3 text-gray-900 dark:text-blue-200">Reset password</div>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">New password</label>
            <input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} className="w-full p-3 rounded-lg bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Enter new password" />
          </div>
          <div>
            <label className="block text-xs mb-1 text-gray-700 dark:text-blue-200">Confirm password</label>
            <input type="password" value={confirm} onChange={(e)=>setConfirm(e.target.value)} className="w-full p-3 rounded-lg bg-white dark:bg-neutral-800 border border-gray-300 dark:border-blue-900/50" placeholder="Re-enter new password" />
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          {success && <div className="text-sm text-green-600">{success}</div>}
          <div className="flex items-center justify-end">
            <button disabled={loading} type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white disabled:opacity-60">{loading ? 'Saving...' : 'Reset password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ResetPasswordPage;


