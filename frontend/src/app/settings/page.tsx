'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const { user, refreshUser, logout } = useAuth();
  const router = useRouter();

  // Profile
  const [name, setName] = useState('');
  const [profileMsg, setProfileMsg] = useState('');

  // Password
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passMsg, setPassMsg] = useState('');

  // Poly keys
  const [polyKeys, setPolyKeys] = useState({
    privateKey: '', apiKey: '', apiSecret: '', apiPassphrase: '', funderAddress: '', signatureType: '2',
  });
  const [keyStatus, setKeyStatus] = useState<any>(null);
  const [keysMsg, setKeysMsg] = useState('');

  useEffect(() => {
    if (!user) { router.push('/login'); return; }
    setName(user.name || '');
    loadKeyStatus();
  }, [user, router]);

  async function loadKeyStatus() {
    try {
      const res = await apiFetch('/api/auth/poly-keys/status');
      if (res.ok) setKeyStatus(await res.json());
    } catch {}
  }

  async function saveProfile() {
    setProfileMsg('');
    const res = await apiFetch('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ name }) });
    if (res.ok) { await refreshUser(); setProfileMsg('Сохранено'); }
    else setProfileMsg('Ошибка');
  }

  async function changePassword() {
    setPassMsg('');
    const res = await apiFetch('/api/auth/password', {
      method: 'PATCH', body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await res.json();
    if (res.ok) { setPassMsg('Пароль изменён'); setOldPassword(''); setNewPassword(''); }
    else setPassMsg(data.error || 'Ошибка');
  }

  async function savePolyKeys() {
    setKeysMsg('');
    const body: Record<string, any> = {};
    if (polyKeys.privateKey) body.privateKey = polyKeys.privateKey;
    if (polyKeys.apiKey) body.apiKey = polyKeys.apiKey;
    if (polyKeys.apiSecret) body.apiSecret = polyKeys.apiSecret;
    if (polyKeys.apiPassphrase) body.apiPassphrase = polyKeys.apiPassphrase;
    if (polyKeys.funderAddress) body.funderAddress = polyKeys.funderAddress;
    body.signatureType = parseInt(polyKeys.signatureType) || 0;

    const res = await apiFetch('/api/auth/poly-keys', { method: 'PUT', body: JSON.stringify(body) });
    if (res.ok) {
      setKeysMsg('Ключи сохранены');
      setPolyKeys({ privateKey: '', apiKey: '', apiSecret: '', apiPassphrase: '', funderAddress: '', signatureType: polyKeys.signatureType });
      await loadKeyStatus();
    } else {
      const d = await res.json();
      setKeysMsg(d.error || 'Ошибка');
    }
  }

  async function deletePolyKeys() {
    if (!confirm('Удалить все ключи Polymarket?')) return;
    await apiFetch('/api/auth/poly-keys', { method: 'DELETE' });
    setKeysMsg('Ключи удалены');
    await loadKeyStatus();
  }

  if (!user) return null;

  const subEnd = user.subscriptionEnd ? new Date(user.subscriptionEnd) : null;
  const subActive = subEnd && subEnd > new Date();

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Настройки</h1>

      {/* Profile */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">Профиль</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-500">Email</label>
            <div className="text-white mt-1">{user.email}</div>
          </div>
          <div>
            <label className="text-sm text-gray-500">Роль</label>
            <div className="mt-1">
              <span className={`text-xs px-2 py-0.5 rounded ${user.role === 'admin' ? 'bg-purple-500/20 text-purple-300' : 'bg-gray-700 text-gray-300'}`}>
                {user.role}
              </span>
            </div>
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Имя</label>
          <div className="flex gap-2">
            <input value={name} onChange={e => setName(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            <button onClick={saveProfile} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm">Сохранить</button>
          </div>
          {profileMsg && <p className="text-sm text-green-400 mt-1">{profileMsg}</p>}
        </div>
      </section>

      {/* Subscription */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-200 mb-3">Подписка</h2>
        {subActive ? (
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
            <span className="text-green-400">Активна до {subEnd!.toLocaleDateString('ru-RU')}</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            <span className="text-red-400">{subEnd ? 'Подписка истекла' : 'Нет активной подписки'}</span>
          </div>
        )}
        {user.role === 'admin' && (
          <p className="text-xs text-gray-600 mt-2">Администраторам подписка не требуется</p>
        )}
      </section>

      {/* Password */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">Смена пароля</h2>
        <div className="grid grid-cols-2 gap-4">
          <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)}
            placeholder="Текущий пароль"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder="Новый пароль (мин. 6)"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={changePassword} disabled={!oldPassword || !newPassword}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm">
            Сменить пароль
          </button>
          {passMsg && <p className={`text-sm ${passMsg === 'Пароль изменён' ? 'text-green-400' : 'text-red-400'}`}>{passMsg}</p>}
        </div>
      </section>

      {/* Polymarket Keys */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-200">Polymarket API Keys</h2>
          {keyStatus && (
            <span className={`text-xs px-2 py-1 rounded ${keyStatus.configured ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
              {keyStatus.configured ? 'Настроены' : 'Не настроены'}
            </span>
          )}
        </div>

        {keyStatus?.configured && (
          <div className="text-sm text-gray-400 space-y-1">
            <div>Private Key: {keyStatus.hasPrivateKey ? '●●●●●●●●' : '—'}</div>
            <div>API Key: {keyStatus.hasApiKey ? '●●●●●●●●' : '—'}</div>
            <div>Funder: {keyStatus.funderAddress || '—'}</div>
            <div>Signature Type: {keyStatus.signatureType}</div>
          </div>
        )}

        <div className="space-y-3">
          <input value={polyKeys.privateKey} onChange={e => setPolyKeys(p => ({ ...p, privateKey: e.target.value }))}
            placeholder="Private Key (0x...)" type="password"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
          <div className="grid grid-cols-2 gap-3">
            <input value={polyKeys.apiKey} onChange={e => setPolyKeys(p => ({ ...p, apiKey: e.target.value }))}
              placeholder="API Key" type="password"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            <input value={polyKeys.apiSecret} onChange={e => setPolyKeys(p => ({ ...p, apiSecret: e.target.value }))}
              placeholder="API Secret" type="password"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={polyKeys.apiPassphrase} onChange={e => setPolyKeys(p => ({ ...p, apiPassphrase: e.target.value }))}
              placeholder="API Passphrase" type="password"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            <input value={polyKeys.funderAddress} onChange={e => setPolyKeys(p => ({ ...p, funderAddress: e.target.value }))}
              placeholder="Funder Address (optional)"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
          </div>
          <select value={polyKeys.signatureType} onChange={e => setPolyKeys(p => ({ ...p, signatureType: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
            <option value="0">Signature Type: 0 (EOA)</option>
            <option value="2">Signature Type: 2 (Gnosis Safe)</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={savePolyKeys} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm">Сохранить ключи</button>
          {keyStatus?.configured && (
            <button onClick={deletePolyKeys} className="bg-red-600/20 hover:bg-red-600/30 text-red-400 px-4 py-2 rounded-lg text-sm border border-red-600/30">
              Удалить ключи
            </button>
          )}
          {keysMsg && <p className={`text-sm ${keysMsg.includes('Ошибка') ? 'text-red-400' : 'text-green-400'}`}>{keysMsg}</p>}
        </div>
      </section>

      {/* Logout */}
      <div className="text-center pb-8">
        <button onClick={() => { logout(); router.push('/login'); }}
          className="text-gray-500 hover:text-red-400 text-sm transition-colors">
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}
