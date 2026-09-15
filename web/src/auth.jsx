// There is no sign-up here: somebody sold this account. The entry screen uses
// the same four-place mental model as the desktop, so the product is understood
// before the first file is shown without depending on a particular wordmark.
//
// It is also the first thing a customer of a hosting company ever sees, and the
// hosting company's name is the one that belongs on it. Where they have set a
// brand this screen carries theirs; where they have not, the fallbacks below are
// the neutral words, which are true on any box and name no product.

import { useEffect, useState } from 'react';
import { api, session } from './api.js';
import { brand, named } from './brand.js';
import { Button, BrandMark, Field, Icon, Mark, Note, PLACES } from './ui.jsx';

export function AuthScreen({ mode, token, notice, onSignedIn }) {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-label={mode === 'signin' ? 'Sign in' : 'Account access'}>
        <aside className="auth-card__story">
          <div className="auth-card__brand"><BrandMark size={36} /><span>{named('Files on your terms')}</span></div>
          <div className="auth-card__message">
            <h1>Private until you choose otherwise.</h1>
            <p>{brand.tagline || 'A file\u2019s reach is always visible, and every crossing can be taken back.'}</p>
          </div>
          <div className="auth-places" aria-label="The four file places">
            {Object.values(PLACES).map(place => (
              <div key={place.key} className="auth-place" style={{ '--place': place.tone, '--place-soft': place.wash }}>
                <span><Icon name={place.icon} size={16} /></span>
                <div><strong>{place.label}</strong><small>{place.hint}</small></div>
              </div>
            ))}
          </div>
        </aside>

        <div className="auth-card__form">
          <div className="auth-card__form-heading">
            <BrandMark size={30} />
            <div><strong>{named('Your files')}</strong><span>Stored on this box</span></div>
          </div>
          {mode === 'reset' ? <ResetForm token={token} />
            : mode === 'confirm' ? <ConfirmAddress token={token} />
              : <>{notice ? <Note tone="bad">{notice}</Note> : null}<SignInForm onSignedIn={onSignedIn} /></>}
        </div>
      </section>
    </main>
  );
}

function SignInForm({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  const go = async event => {
    event.preventDefault();
    setBusy(true); setError(null); setUnconfirmed(false);
    try {
      const out = await api.signIn(email.trim(), password);
      session.set(out.token);
      onSignedIn(out.user);
    } catch (err) {
      setError(err.message);
      if (err.status === 403 && /confirm/i.test(err.message)) setUnconfirmed(true);
    } finally { setBusy(false); }
  };

  const forgotten = async () => {
    setError(null);
    try { await api.requestReset(email.trim()); } catch { /* same answer by design */ }
    setAsked(true);
  };

  const resend = async () => {
    try { await api.resendConfirmation(email.trim()); } catch { /* same answer by design */ }
    setAsked(true);
  };

  if (asked) {
    return (
      <div className="auth-result">
        <Note tone="good">
          If that address has an account here, something is on its way to it now. The link works once and does not last long.
        </Note>
        <Button onClick={() => setAsked(false)}>Back to sign in</Button>
      </div>
    );
  }

  return (
    <form onSubmit={go} className="auth-form">
      <div className="auth-form__title"><h2>Sign in</h2><p>Open your private workspace.</p></div>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Field label="Email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      <Button kind="solid" type="submit" disabled={busy} className="button--wide">
        {busy ? 'One moment…' : 'Sign in'}
      </Button>
      <div className="auth-form__links">
        <button type="button" onClick={forgotten}>Forgotten your password?</button>
        {unconfirmed && <button type="button" onClick={resend}>Send the confirmation again</button>}
      </div>
      <p className="auth-form__footnote">
        There is no sign-up. Accounts here are made by whoever sells you this — ask them.
        {brand.support ? <> <a href={brand.support}>{brand.supportLabel || 'Get help'}</a>.</> : null}
      </p>
    </form>
  );
}

function ResetForm({ token }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const go = async event => {
    event.preventDefault();
    if (password !== again) { setError('Those two are not the same.'); return; }
    setBusy(true); setError(null);
    try { await api.confirmReset(token, password); setDone(true); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="auth-result">
        <Note tone="good">That is done. Everything that was signed in has been signed out, including whoever you were worried about.</Note>
        <Button kind="solid" onClick={() => { window.location.href = '/'; }} className="button--wide">Sign in</Button>
      </div>
    );
  }

  return (
    <form onSubmit={go} className="auth-form">
      <div className="auth-form__title"><h2>Choose a new password</h2><p>The link works once.</p></div>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Field label="New password" type="password" autoComplete="new-password" required minLength={12}
        value={password} onChange={e => setPassword(e.target.value)} hint="Twelve characters or more." />
      <Field label="Again" type="password" autoComplete="new-password" required minLength={12}
        value={again} onChange={e => setAgain(e.target.value)} />
      <Button kind="solid" type="submit" disabled={busy} className="button--wide">
        {busy ? 'Setting it…' : 'Set the password'}
      </Button>
    </form>
  );
}

function ConfirmAddress({ token }) {
  const [state, setState] = useState('working');
  useEffect(() => {
    api.confirmAddress(token).then(() => setState('done')).catch(() => setState('failed'));
  }, [token]);
  if (state === 'working') return <Note>Confirming…</Note>;
  if (state === 'failed') {
    return (
      <div className="auth-result">
        <Note tone="bad">That link has expired or has already been used. Ask for another one from the sign-in screen.</Note>
        <Button onClick={() => { window.location.href = '/'; }} className="button--wide">Back to sign in</Button>
      </div>
    );
  }
  return (
    <div className="auth-result">
      <Note tone="good">Confirmed. The account is yours.</Note>
      <Button kind="solid" onClick={() => { window.location.href = '/'; }} className="button--wide">Sign in</Button>
    </div>
  );
}

export { Mark };
