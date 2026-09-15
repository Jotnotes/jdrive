// The console the person selling this uses.
//
// A different surface for a different job. The customer's side is a desktop
// because a customer looks at their own things; this is a working tool for
// somebody who looks at other people's accounts all day, so it is a table, it is
// dense, and nothing floats. Same tokens, same components, same words —
// adapted, not redesigned.
//
// One console, scoped by who is signed in. A hosting company sees the accounts
// they sell to, including their resellers; a reseller sees their own customers
// and nothing above or beside them. That is not a second portal: it is the same
// screen answering the same question about a different person, which is what the
// box already does on every commercial route.
//
// It offers exactly what the box can enforce. The capability switches are built
// from the metric registry the server reports, so a console can never sell
// something the product does not gate.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, session } from './api.js';
import { brand } from './brand.js';
import { Sheet } from './share.jsx';
import { BrandMark, Button, Field, Icon, Note, bytes, when } from './ui.jsx';
import { ROLE_WORDS, GIGABYTE, BY_GIGABYTE, bar, label, entitlementWords, plainly, toStored } from './console-parts.jsx';
import { hosting } from './edition.js';
import './console.css';

// Which section is open is kept in the address. It is not a route — the console
// is one screen — but saving a brand reloads the page, because the brand reaches
// the shell before the bundle runs, and coming back to a different section than
// the one you pressed Save in reads as the save having gone somewhere else.
//
// The Hosting edition adds its sections to the core's two. A Community build has
// no overview, so it opens on the account list.
const VIEWS = ['customers', 'archives', ...(hosting ? hosting.views : [])];
const openingView = () => {
  const asked = String(window.location.hash || '').replace('#', '');
  // The landing section. It used to be the account table, which answered a
  // question nobody opens a console to ask first.
  return VIEWS.includes(asked) ? asked : (hosting ? 'overview' : 'customers');
};

export function Console({ me, onLeave, onSignOut }) {
  const [view, setView] = useState(openingView);
  const [accounts, setAccounts] = useState([]);
  const [packages, setPackages] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [archives, setArchives] = useState({ count: 0, bytes: 0, archives: [] });
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [box, setBox] = useState(null);
  const [licence, setLicence] = useState(null);

  const load = useCallback(async () => {
    try {
      const [people, plans, sellable, sealed, credentials, thisBox, licensing] = await Promise.all([
        api.accounts(),
        hosting ? hosting.api.packages().catch(() => []) : [],
        api.metrics().catch(() => []),
        // A reseller is refused this and that is the design, not a failure, so
        // it falls back to nothing rather than reddening the whole screen.
        api.archives().catch(() => ({ count: 0, bytes: 0, archives: [] })),
        // A reseller holds their own keys, so unlike archives this is not
        // scoped away from them; it falls back to nothing only if the box is
        // older than the feature.
        hosting ? hosting.api.keys().catch(() => []) : [],
        // A box older than this feature does not answer here. That is not an
        // error, it is an older box, so it falls back to nothing and the line
        // simply does not appear.
        api.box().catch(() => null),
        // An older box has no licence route; that is not an error, it is no banner.
        hosting ? hosting.api.licence().catch(() => null) : null,
      ]);
      setAccounts(people || []);
      setPackages(plans || []);
      setMetrics(sellable || []);
      setArchives(sealed || { count: 0, bytes: 0, archives: [] });
      setKeys(credentials || []);
      setBox(thisBox || null);
      setLicence(licensing || null);
      setError(null);
    } catch (err) { setError(err.message); } finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A refusal belongs to the thing that was refused. One error serves the page
  // and every sheet, so without this a plan refused on one customer's sheet
  // opened at the top of the next customer's, and followed onto the Plans page.
  // Cleared on opening a sheet and on changing section, never on closing one: a
  // sheet that closes after a failed create leaves its refusal on the page.
  useEffect(() => { setError(null); }, [view]);
  useEffect(() => { if (sheet) setError(null); }, [sheet]);

  const act = async fn => {
    setBusy(true);
    setError(null);
    // The result is handed back, not swallowed: a caller that wants to say what
    // happened needs what happened. Callers that do not, ignore it.
    try { const out = await fn(); await load(); return out; }
    catch (err) { setError(err.message); return null; }
    finally { setBusy(false); }
  };

  const live = packages.filter(plan => plan.status === 'active');

  return (
    <div className="console">
      <header className="console-bar">
        <div className="console-bar__brand"><BrandMark size={22} /><span>Console</span></div>
        <span className="console-bar__role">{ROLE_WORDS[me.role] || 'Seller'} · {me.email}</span>
        <div className="console-bar__spacer" />
        <Button kind="ghost" icon="folder" onClick={onLeave}>My files</Button>
        <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
      </header>

      <div className="console-body">
        <nav className="console-nav" aria-label="Console sections">
          {hosting && (
          <button type="button" className="console-nav__item" aria-current={view === 'overview' ? 'page' : undefined}
            onClick={() => { setView('overview'); window.location.hash = 'overview'; }}>
            <Icon name="compact" size={16} /><span>Overview</span>
          </button>
          )}
          <button type="button" className="console-nav__item" aria-current={view === 'customers' ? 'page' : undefined}
            onClick={() => { setView('customers'); window.location.hash = 'customers'; }}>
            <Icon name="file" size={16} /><span>Accounts</span><small>{accounts.length}</small>
          </button>
          {hosting && (
          <button type="button" className="console-nav__item" aria-current={view === 'packages' ? 'page' : undefined}
            onClick={() => { setView('packages'); window.location.hash = 'packages'; }}>
            <Icon name="copy" size={16} /><span>Plans</span><small>{live.length}</small>
          </button>
          )}
          {/* A reseller holds their own keys and issues them for their own
              scope, so this is not an operator-only section: the whole point of
              the credential is that whoever sells accounts can automate selling
              them. */}
          {/* Transfer policy is the operator's: it is one switch for the whole
              box, not something a reseller sets for their own slice. The meter
              itself is everybody's and shows in the account list above. */}
          {hosting && me.role === 'hosting_company' && (
            <button type="button" className="console-nav__item" aria-current={view === 'transfer' ? 'page' : undefined}
              onClick={() => { setView('transfer'); window.location.hash = 'transfer'; }}>
              <Icon name="publish" size={16} /><span>Transfer</span>
            </button>
          )}
          {hosting && (
          <button type="button" className="console-nav__item" aria-current={view === 'keys' ? 'page' : undefined}
            onClick={() => { setView('keys'); window.location.hash = 'keys'; }}>
            <Icon name="key" size={16} /><span>API keys</span><small>{keys.filter(k => !k.revoked).length}</small>
          </button>
          )}
          {/* Archives sit on the operator's disk and hold former customers'
              files, so like the brand they belong to whoever owns the box. A
              reseller who terminates their own customer makes one and does not
              hold it. */}
          {me.role === 'hosting_company' && (
            <button type="button" className="console-nav__item" aria-current={view === 'archives' ? 'page' : undefined}
              onClick={() => { setView('archives'); window.location.hash = 'archives'; }}>
              <Icon name="lock" size={16} /><span>Archives</span><small>{archives.count}</small>
            </button>
          )}
          {/* Support access is a position a company takes about its own
              customers, so unlike the brand and the archives a reseller has one
              of their own. It sits beside branding rather than beside the plans
              because it is configured and inherited and is never sold. */}
          {hosting && (
          <button type="button" className="console-nav__item" aria-current={view === 'support' ? 'page' : undefined}
            onClick={() => { setView('support'); window.location.hash = 'support'; }}>
            <Icon name="restore" size={16} /><span>Support access</span>
          </button>
          )}
          {/* The brand belongs to whoever owns the box. A reseller sells with the
              same machinery one level down but under the same name, so this is
              the one console section that is not theirs. */}
          {hosting && me.role === 'hosting_company' && (
            <button type="button" className="console-nav__item" aria-current={view === 'licence' ? 'page' : undefined}
              onClick={() => { setView('licence'); window.location.hash = 'licence'; }}>
              <Icon name="key" size={16} /><span>Licence</span>
            </button>
          )}
          {hosting && me.role === 'hosting_company' && (
            <button type="button" className="console-nav__item" aria-current={view === 'branding' ? 'page' : undefined}
              onClick={() => { setView('branding'); window.location.hash = 'branding'; }}>
              <Icon name="eye" size={16} /><span>Branding</span>
            </button>
          )}
          <p className="console-nav__rule">
            <Icon name="info" size={14} />
            {hosting
              ? 'You set the plans and the prices. This box enforces the limits in them and nothing else.'
              : 'You add the people who use this box and set how much each of them may store.'}
          </p>
          {/* What this box is. Every word of it comes from the box rather than
              from this bundle: the product's own name is on the wrong side of
              the white-label guard, and a customer must never see it. Whoever
              is reading this screen sells accounts, so they may. */}
          {box && (
            <p className="console-nav__build" title={box.commit || undefined}>
              <span>{box.product} {box.version}</span>
              <span>
                {box.commit ? box.commit.slice(0, 7) : box.channel}
                {box.schema ? ` · schema ${box.schema.version} of ${box.schema.known}` : ''}
              </span>
            </p>
          )}
        </nav>

        <main className="console-main">
          {me.role === 'hosting_company' && box && box.update && box.update.available && (
            <Note tone={box.update.security ? 'bad' : 'info'}>
              Version {box.update.version} is available{box.update.security ? ' — security fix' : ''}.{' '}
              <a href={box.update.notes} target="_blank" rel="noreferrer">Release notes</a>
            </Note>
          )}
          {hosting && (
            <hosting.LicenceBanner licence={licence} operator={me.role === 'hosting_company'}
              onOpen={() => { setView('licence'); window.location.hash = 'licence'; }} />
          )}
          {error && <Note tone="bad">{plainly(error)}</Note>}
          {hosting && view === 'licence' && me.role === 'hosting_company' && (
            <hosting.Licence licence={licence} onInstalled={load} />
          )}

          {hosting && view === 'overview' && (
            <hosting.Overview
              me={me}
              onGo={where => { setView(where); window.location.hash = where; }}
            />
          )}

          {view === 'customers' && (
            <Accounts
              accounts={accounts}
              packages={live}
              loaded={loaded}
              busy={busy}
              canMakeSeller={!!hosting && me.role === 'hosting_company'}
              onOpen={account => setSheet({ kind: 'account', account })}
              onNew={role => setSheet({ kind: 'new', role })}
              onSuspend={account => act(() => (account.suspended ? api.restoreAccount(account.id) : api.suspendAccount(account.id)))}
            />
          )}

          {hosting && view === 'support' && <hosting.SupportAccess busy={busy} onChanged={load} />}

          {hosting && view === 'branding' && me.role === 'hosting_company' && <hosting.Branding />}

          {hosting && view === 'packages' && (
            <hosting.Packages
              packages={packages}
              accounts={accounts}
              metrics={metrics}
              busy={busy}
              onNew={() => setSheet({ kind: 'plan' })}
              onArchive={plan => act(() => hosting.api.archivePackage(plan.id))}
            />
          )}

          {hosting && view === 'transfer' && me.role === 'hosting_company' && <hosting.Transfer busy={busy} />}

          {hosting && view === 'keys' && (
            <hosting.Keys
              keys={keys}
              busy={busy}
              onIssue={(name, kind) => hosting.api.issueKey(name, kind).then(async out => { await load(); return out; })}
              onRevoke={id => act(() => hosting.api.revokeKey(id))}
            />
          )}

          {view === 'archives' && (
            <Archives
              archives={archives.archives || []}
              total={{ count: archives.count, bytes: archives.bytes }}
              busy={busy}
              onVerify={id => api.verifyArchive(id).catch(err => ({ ok: false, problems: [err.message] }))}
              onRestore={id => act(() => api.restoreArchive(id))}
              onDestroy={id => act(() => api.destroyArchive(id))}
            />
          )}
        </main>
      </div>

      {/* `openAccount` is the row as it was when the sheet was opened, and every
          handler below has to ask the list for the live one instead. The sheet
          was already rendering the live row and deciding suspend-versus-restore
          from the stale one, which is a button that says the opposite of what it
          does: suspend a reseller, press "Let them back in" on the same open
          sheet, and the box suspends them a second time. Nothing in the audit
          could see it — the requests it sends are both real and both answer 200
          — and clicking found it inside a minute. */}
      {sheet && sheet.kind === 'account' && (() => {
        const openAccount = accounts.find(row => row.id === sheet.account.id) || sheet.account;
        return (
        <AccountSheet
          account={openAccount}
          accounts={accounts}
          me={me}
          packages={live}
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onAssign={packageId => act(() => hosting.api.assignPackage(openAccount.id, packageId))}
          onSuspend={() => act(() => (openAccount.suspended
            ? api.restoreAccount(openAccount.id)
            : api.suspendAccount(openAccount.id)))}
          onReload={load}
          onError={err => setError(err.message)}
          onEnded={async () => { setSheet(null); await load(); }}
        />
        );
      })()}

      {sheet && sheet.kind === 'new' && (
        <NewAccountSheet
          role={sheet.role}
          busy={busy}
          onClose={() => setSheet(null)}
          onDone={async body => { await act(() => api.createAccount(body)); setSheet(null); }}
        />
      )}

      {hosting && sheet && sheet.kind === 'plan' && (
        <hosting.NewPlanSheet
          metrics={metrics}
          busy={busy}
          onClose={() => setSheet(null)}
          onDone={async body => { await act(() => hosting.api.createPackage(body)); setSheet(null); }}
        />
      )}
    </div>
  );
}

function Accounts({ accounts, packages, loaded, busy, canMakeSeller, onOpen, onNew, onSuspend }) {
  const [find, setFind] = useState('');
  const [only, setOnly] = useState('all');
  // Sorted here rather than by the box, for the same reason the filter is: the
  // list is already loaded, and a sort that costs a round trip is a sort people
  // stop using. `null` means the order the box sent, which is the order accounts
  // were created — a real answer to "who is new", and not one any column gives.
  const [sort, setSort] = useState(null);

  const sortBy = column => setSort(current => {
    if (!current || current.column !== column) return { column, down: false };
    // Third press goes back to the box's own order rather than cycling between
    // two directions for ever, so there is always a way back to "newest last".
    return current.down ? null : { column, down: true };
  });

  // Name, address and plan, because those are the three things somebody has in
  // front of them when they come looking: a support ticket, an invoice, or a
  // question about what somebody is on. Matching is done here rather than by the
  // box — the list is already loaded, and a filter that costs a round trip is a
  // filter people stop using.
  const needle = find.trim().toLowerCase();
  const shown = accounts.filter(account => {
    if (only === 'suspended' && !account.suspended) return false;
    if (only === 'unconfirmed' && account.confirmed) return false;
    if (only === 'resellers' && account.role !== 'reseller') return false;
    if (!needle) return true;
    return [account.name, account.email, account.package && account.package.name]
      .some(field => String(field || '').toLowerCase().includes(needle));
  });

  // What each column sorts on. Storage deliberately sorts on the *fraction* of
  // the allowance rather than on bytes: a hoster scanning this column is looking
  // for who is about to run out, and the biggest account is very often the one
  // with the biggest plan and the most room left. An unlimited account has no
  // fraction, so it sorts as empty rather than as full.
  const SORT_KEYS = {
    account: row => String(row.name || row.email || '').toLowerCase(),
    kind: row => String(ROLE_WORDS[row.role] || row.role || '').toLowerCase(),
    plan: row => String((row.package && row.package.name) || '').toLowerCase(),
    // The exact fraction, computed from bytes here rather than read off
    // `percent_used`, which the box rounds to a whole number. On a 5GB plan
    // everything under about 27MB rounds to 0, so sorting on it put 725KB above
    // 0B and looked broken to anybody watching — found by clicking, not by any
    // test. An unlimited account has no fraction and can never be full, so it
    // sorts at the empty end rather than pretending to a number.
    transfer: row => {
      const t = row.transfer;
      if (!t || t.unlimited) return -1;
      return typeof t.fraction === 'number' ? t.fraction : -1;
    },
    storage: row => {
      const usage = row.usage;
      if (!usage || usage.unlimited) return -1;
      const limit = Number(usage.limit_bytes || 0);
      return limit > 0 ? Number(usage.used_bytes || 0) / limit : -1;
    },
    state: row => (row.suspended ? 2 : row.confirmed ? 0 : 1),
  };

  const ordered = useMemo(() => {
    if (!sort || !SORT_KEYS[sort.column]) return shown;
    const key = SORT_KEYS[sort.column];
    // A copy, because `shown` is derived from props and sorting in place would
    // reorder the array React is holding.
    return [...shown].sort((a, b) => {
      const left = key(a);
      const right = key(b);
      const order = typeof left === 'number' ? left - right : String(left).localeCompare(String(right));
      // Ties are broken by name rather than left to whatever the previous sort
      // happened to leave behind. Two accounts on the same plan with the same
      // usage should land in the same order every time somebody presses the
      // column, or the table looks like it is shuffling for no reason.
      if (order === 0) {
        const byName = String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
        return sort.down ? -byName : byName;
      }
      return sort.down ? -order : order;
    });
  }, [shown, sort]);

  return (
    <>
      <div className="console-head">
        <div>
          <h1>Accounts</h1>
          <p>{hosting
            ? <>Everybody you sell to, one level down. A reseller&apos;s own customers are theirs.</>
            : 'Everybody who uses this box. You add them; there is no sign-up.'}</p>
        </div>
        <div className="console-head__actions">
          {canMakeSeller && <Button icon="add" onClick={() => onNew('reseller')} disabled={busy}>New reseller</Button>}
          <Button kind="solid" icon="add" onClick={() => onNew('end_user')} disabled={busy}>{hosting ? 'New customer' : 'Add a person'}</Button>
        </div>
      </div>

      {loaded && accounts.length === 0 && (
        <p className="console-empty">
          Nobody yet. Every account here is one you made: there is no sign-up, which is the business rather than a limitation.
        </p>
      )}

      {accounts.length > 0 && (
        <div className="console-filter">
          <label className="field field--inline">
            <span className="visually-hidden">Find an account</span>
            <input className="field__input" type="search" value={find} placeholder={hosting ? 'Name, address or plan' : 'Name or address'}
              onChange={event => setFind(event.target.value)} />
          </label>
          <div className="segmented" role="group" aria-label="Show">
            {/* Resellers only for whoever can have them: a reseller's list never holds one. */}
            {[['all', 'All'], ['suspended', 'Suspended'], ['unconfirmed', 'Unconfirmed'], ...(canMakeSeller ? [['resellers', 'Resellers']] : [])].map(([key, label]) => (
              <button type="button" key={key} aria-pressed={only === key} onClick={() => setOnly(key)}>{label}</button>
            ))}
          </div>
          <span className="console-filter__count">
            {shown.length === accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : `${shown.length} of ${accounts.length}`}
          </span>
        </div>
      )}

      {accounts.length > 0 && shown.length === 0 && (
        <p className="console-empty">Nothing matches that.</p>
      )}

      {shown.length > 0 && (
        <table className="console-table">
          <thead>
            <tr>
              {/* Plans and transfer are the Hosting edition's, and so is a second kind of
                  account, so a Community box shows the three columns it has. */}
              {(hosting
                ? [['account', 'Account'], ['kind', 'Kind'], ['plan', 'Plan'], ['storage', 'Storage'], ['transfer', 'Transfer'], ['state', 'State']]
                : [['account', 'Account'], ['storage', 'Storage'], ['state', 'State']]).map(([key, label]) => (
                <th
                  scope="col"
                  key={key}
                  // Announced rather than only drawn: a sorted column is a fact
                  // about the table, and `aria-sort` is how a screen reader is
                  // told which one and which way.
                  aria-sort={sort && sort.column === key ? (sort.down ? 'descending' : 'ascending') : 'none'}
                >
                  <button type="button" className="console-sort" onClick={() => sortBy(key)}>
                    {label}
                    {/* Only the column actually sorting gets a mark. An arrow on
                        every header reads as "all of these are sorted", which is
                        a red mark over a working thing in the other direction. */}
                    {sort && sort.column === key && <Icon name={sort.down ? 'unpublish' : 'publish'} size={12} />}
                  </button>
                </th>
              ))}
              <th scope="col"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(account => (
              <tr key={account.id}>
                <th scope="row">
                  <button type="button" className="console-link" onClick={() => onOpen(account)}>{account.name}</button>
                  <small>{account.email}</small>
                </th>
                {hosting && (
                  <td>
                    {ROLE_WORDS[account.role] || account.role}
                    {account.role === 'reseller' && <small>{account.customers} of their own</small>}
                  </td>
                )}
                {hosting && <td>{account.package ? account.package.name : <span className="console-muted">No plan</span>}</td>}
                <td><Allowance usage={account.usage} /></td>
                {/* Storage is what they bought; transfer is what they spend.
                    A seller looking at one without the other is looking at
                    half a bill. */}
                {hosting && <td><Allowance usage={account.transfer} window={account.transfer && account.transfer.window_days} /></td>}
                <td><State account={account} /></td>
                <td className="console-table__actions">
                  <Button onClick={() => onOpen(account)} disabled={busy}>Open</Button>
                  <Button kind={account.suspended ? 'quiet' : 'danger'} onClick={() => onSuspend(account)} disabled={busy}>
                    {account.suspended ? 'Restore' : 'Suspend'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hosting && packages.length === 0 && accounts.length > 0 && (
        <Note tone="quiet">
          No plans yet, so every account has whatever this box gives away by default. Make a plan to sell a limit.
        </Note>
      )}
    </>
  );
}

// Used against sold, as a number and as a bar. The same figures the customer
// sees on their own screen, so a support call about a full account is two people
// reading one number.
function Allowance({ usage, window: windowDays = null }) {
  if (!usage) return <span className="console-muted">—</span>;
  // Storage reports a rounded percent; transfer reports an exact fraction. Both
  // are accepted rather than one being recomputed here, because the number on
  // this bar and the number the box enforces on have to be the same number.
  const percent = usage.unlimited ? 0
    : (typeof usage.fraction === 'number' ? usage.fraction * 100 : Number(usage.percent_used || 0));
  return (
    <div
      className="allowance"
      title={windowDays
        ? `${usage.used_human} of ${usage.limit_human || 'no limit'} in the last ${windowDays} days`
        : `${usage.used_human} of ${usage.limit_human}`}
    >
      <div className="allowance__bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, percent)}%` }} data-full={percent >= 90} />
      </div>
      <span className="allowance__text">
        <strong>{usage.used_human || bytes(usage.used_bytes)}</strong>
        <small>of {usage.unlimited ? 'no limit' : (usage.limit_human || bytes(usage.limit_bytes))}</small>
      </span>
    </div>
  );
}

function State({ account }) {
  if (account.suspended) return <span className="state state--suspended"><Icon name="lock" size={12} />Suspended</span>;
  if (!account.confirmed) return <span className="state state--waiting"><Icon name="clock" size={12} />Unconfirmed</span>;
  return <span className="state state--live"><Icon name="check" size={12} />Active</span>;
}

function AccountSheet({ account, accounts, me, packages, busy, error, onClose, onAssign, onSuspend, onReload, onError, onEnded }) {
  const [entitlements, setEntitlements] = useState(null);
  // Bumped by anything that changes what this account is entitled to, so the
  // limits and the plan are re-read from the box rather than patched here. A
  // console that edits its own copy of the answer is a console that disagrees
  // with the box the moment anything else touches the account.
  const [reread, setReread] = useState(0);
  const [disk, setDisk] = useState(null);
  const [checking, setChecking] = useState(false);
  const [trail, setTrail] = useState(null);
  const [more, setMore] = useState(null);

  // Re-read when the plan changes, not only when the sheet opens. Assigning a
  // plan and then being shown the terms of the old one is a console lying about
  // the thing it was just used to do.
  const onPlan = account.package ? account.package.id : '';
  useEffect(() => {
    let alive = true;
    setEntitlements(null);
    api.entitlements(account.id).then(out => { if (alive) setEntitlements(out); }).catch(() => {});
    return () => { alive = false; };
  }, [account.id, onPlan, account.suspended, reread]);

  // The box writes this on every meaningful action and, until now, nothing could
  // read it back. What arrives is the account record only — signing in, plans,
  // suspensions, quota refusals. What the customer did with their files stays
  // with the customer, and that is enforced by the box rather than by this list
  // choosing not to show it.
  useEffect(() => {
    let alive = true;
    setTrail(null);
    api.accountTrail(account.id)
      .then(out => { if (alive) { setTrail(out.entries || []); setMore(out.more || null); } })
      .catch(() => { if (alive) setTrail([]); });
    return () => { alive = false; };
  }, [account.id]);

  const olderTrail = async () => {
    if (!more) return;
    const out = await api.accountTrail(account.id, more).catch(() => null);
    if (!out) return;
    setTrail(current => [...(current || []), ...(out.entries || [])]);
    setMore(out.more || null);
  };

  const reconcile = async () => {
    setChecking(true);
    try { setDisk(await api.reconcile(account.id)); }
    catch (err) { setDisk({ error: err.message }); }
    finally { setChecking(false); }
  };

  return (
    <Sheet title={account.name} eyebrow={ROLE_WORDS[account.role] || account.role} onClose={onClose}>
      {/* A refusal has to appear where the thing was attempted. This was showing
          on the page behind the sheet, which is a message nobody who needed it
          could read. */}
      {error && <Note tone="bad">{plainly(error)}</Note>}
      <dl className="fact-list">
        <div className="fact-list__row"><dt>Email</dt><dd>{account.email}</dd></div>
        <div className="fact-list__row"><dt>Since</dt><dd>{when(account.created_at)}</dd></div>
        <div className="fact-list__row"><dt>State</dt><dd><State account={account} /></dd></div>
        <div className="fact-list__row"><dt>Storage</dt><dd>{account.usage.used_human} of {account.usage.unlimited ? 'no limit' : account.usage.limit_human}{account.usage.trash_bytes > 0 ? `, ${account.usage.trash_human} of it in the Trash` : ''}</dd></div>
        {/* The list has a Transfer column and this sheet did not, which is the
            one screen where it is actually decided about: ending an account
            moves its transfer onto this box's own line, and the sentence under
            Terminate says so. A figure named in a warning and absent from the
            panel beside it is a number the reader has to go and look up. */}
        {account.transfer && (
          <div className="fact-list__row"><dt>Transfer</dt><dd>{account.transfer.used_human} of {account.transfer.unlimited ? 'no limit' : account.transfer.limit_human}, last {account.transfer.window_days} days</dd></div>
        )}
        {account.role === 'reseller' && (
          <div className="fact-list__row"><dt>Sells to</dt><dd>{account.customers} account{account.customers === 1 ? '' : 's'} of their own</dd></div>
        )}
      </dl>

      {hosting && <hosting.AccountPlan account={account} packages={packages} busy={busy} onAssign={onAssign} />}

      <AccountRecord account={account} onSaved={onReload} onError={onError} />

      <AccountAccess account={account} onError={onError} />

      <AccountLimits
        account={account}
        metrics={(entitlements || {}).metrics}
        onChanged={async () => { setReread(n => n + 1); await onReload(); }}
        onError={onError}
      />

      <section className="details-section">
        <h3 className="details-section__title"><Icon name="lock" size={14} />What they are entitled to</h3>
        {!entitlements && <p className="details-empty">Reading…</p>}
        {entitlements && (
          <dl className="fact-list">
            {(entitlements.metrics || []).map(metric => (
              <div className="fact-list__row" key={metric.metric || metric.metric_key}>
                <dt>{label(metric.metric || metric.metric_key)}</dt>
                <dd>{entitlementWords(metric)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="details-section">
        <h3 className="details-section__title"><Icon name="info" size={14} />The meter against the disk</h3>
        <p className="details-hint">
          The figure above is summed from the database. This asks the disk instead, and says whether the two agree.
        </p>
        {disk && !disk.error && (
          <Note tone={disk.agrees ? 'good' : 'bad'}>
            {disk.agrees
              ? 'They agree.'
              : `They disagree: ${bytes(disk.rows_bytes ?? 0)} recorded against ${bytes(disk.disk_bytes ?? 0)} on the disk.`}
          </Note>
        )}
        {disk && disk.error && <Note tone="bad">{disk.error}</Note>}
        <Button onClick={reconcile} disabled={checking}>{checking ? 'Asking the disk…' : 'Check against the disk'}</Button>
      </section>

      <section className="details-section">
        <h3 className="details-section__title"><Icon name="clock" size={14} />History</h3>
        <p className="details-hint">
          What has happened to this account. What they have done with their files is theirs, and does not appear here.
        </p>
        {trail === null && <p className="details-hint">Reading…</p>}
        {trail && trail.length === 0 && <p className="details-hint">Nothing recorded yet.</p>}
        {trail && trail.length > 0 && (
          <ul className="trail">
            {trail.map(entry => (
              <li key={entry.id} className="trail__row">
                <span className="trail__action">{String(entry.action).replace(/_/g, ' ')}</span>
                {entry.details ? <span className="trail__detail">{entry.details}</span> : <span />}
                <time className="trail__when" dateTime={entry.at}>{when(entry.at)}</time>
              </li>
            ))}
          </ul>
        )}
        {more && <Button onClick={olderTrail}>Older</Button>}
      </section>

      <Suspension account={account} busy={busy} onSuspend={onSuspend} />

      {hosting && <hosting.AccountSeller account={account} accounts={accounts} busy={busy} onMoved={onReload} onError={onError} />}

      {hosting && <hosting.AccountCustomers account={account} accounts={accounts} me={me} onMoved={onReload} onError={onError} />}

      <AccountEnd account={account} keeper={!!me && me.role === 'hosting_company'} onEnded={onEnded} onError={onError} />
    </Sheet>
  );
}

// The clerical half of the sheet: correct what was typed wrong, get somebody
// back in, and give one account a number of its own.
//
// Each of these is one act with one consequence, so each says what the
// consequence is before it is pressed rather than after. The address is the one
// that matters — it is the account's recovery route, so changing it stops the
// account until the new address is proved and tells the address it is leaving.
// That is written on the screen because a hosting company should know it before
// they do it, not from the support call afterwards.
function AccountRecord({ account, onSaved, onError }) {
  const [name, setName] = useState(account.name || '');
  const [email, setEmail] = useState(account.email || '');
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState(null);

  // Keyed on the account and not on its fields. Watching the fields looked more
  // careful and was the bug: saving changes the name, the reload hands back the
  // new one, this fires and clears the confirmation — so a successful save was
  // the one case that never said so. Found by clicking, which is the only way it
  // could have been. The fields are a draft being typed into; re-seeding them
  // from every reload would be the worse failure of the two.
  useEffect(() => { setName(account.name || ''); setEmail(account.email || ''); setSaid(null); }, [account.id]);

  const renaming = name.trim() && name.trim() !== account.name;
  const readdressing = email.trim() && email.trim().toLowerCase() !== account.email;
  const changed = renaming || readdressing;

  const save = async event => {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true); setSaid(null);
    try {
      const body = {};
      if (renaming) body.name = name.trim();
      if (readdressing) body.email = email.trim().toLowerCase();
      const out = await api.editAccount(account.id, body);
      setSaid(out.confirmation
        ? `Saved. The account is stopped until ${out.email} is confirmed, and ${account.email} has been told.`
        : 'Saved.');
      await onSaved();
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  };

  return (
    <section className="details-section">
      <h3 className="details-section__title"><Icon name="rename" size={14} />The record</h3>
      <form onSubmit={save}>
        <Field label="Name" value={name} onChange={event => setName(event.target.value)} />
        <Field label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)}
          hint={readdressing
            ? `This stops the account until ${email.trim().toLowerCase()} is confirmed, and ${account.email} is told it lost the account.`
            : 'Changing this stops the account until the new address is confirmed, and tells the old one.'} />
        {said && <Note tone="good">{said}</Note>}
        <div className="console-form__actions">
          <Button kind="solid" type="submit" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </section>
  );
}

// Two buttons a support desk needs and this console did not have.
//
// The reset is deliberately one a hoster can start and cannot finish: the link
// goes to the customer's address, and nothing about it comes back here. That is
// worth saying on the screen, because somebody expecting a temporary password to
// read out over the phone should find out why there isn't one.
function AccountAccess({ account, onError }) {
  const [busy, setBusy] = useState(null);
  const [said, setSaid] = useState(null);

  useEffect(() => { setSaid(null); }, [account.id]);

  const run = (what, call, sentence) => async () => {
    setBusy(what); setSaid(null);
    try {
      const out = await call();
      setSaid(sentence(out));
      // Exactly one live session in this browser: the borrowed one takes over and
      // the actor's own steps aside until they come back.
      if (out && out.token) { session.standAside(out.token); window.location.href = '/'; }
    } catch (error) { onError(error); }
    finally { setBusy(null); }
  };

  return (
    <section className="details-section">
      <h3 className="details-section__title"><Icon name="restore" size={14} />Getting them back in</h3>
      <p className="details-hint">
        The reset link goes to {account.email} and not to you, so you can start one without ever holding
        a key to their files. If they have lost that mailbox, change the address first.
      </p>
      {said && <Note tone="good">{said}</Note>}
      <div className="console-form__actions">
        <Button
          onClick={run('reset', () => api.startPasswordReset(account.id),
            out => `A reset link went to ${out.sent_to}.`)}
          disabled={!!busy || account.suspended}
        >
          {busy === 'reset' ? 'Sending…' : 'Send a password reset'}
        </Button>
        {!account.confirmed && (
          <Button
            onClick={run('resend', () => api.resendConfirmationFor(account.id),
              out => `The confirmation went to ${out.sent_to} again.`)}
            disabled={!!busy || account.suspended}
          >
            {busy === 'resend' ? 'Sending…' : 'Send the confirmation again'}
          </Button>
        )}
      </div>
      {account.suspended && (
        <p className="details-hint">
          Neither works while the account is suspended. A suspended customer resetting their way back in
          would make suspension advisory.
        </p>
      )}

      {hosting && <hosting.SignInAs account={account} busy={busy} run={run} />}
    </section>
  );
}

// One account's numbers, without a package for it.
//
// Shown against the plan rather than instead of it, because the useful question
// is not "what is the limit" but "what is different here, and why" — and the why
// is required, so a number nobody can account for cannot be written in the first
// place.
function AccountLimits({ account, metrics, onChanged, onError }) {
  const [editing, setEditing] = useState(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setEditing(null); }, [account.id]);

  // Capacities only. A capability is on or off and belongs in a plan, not in a
  // one-account number, and the engine's own `kind` decides which is which
  // rather than a list kept here that goes stale the day a metric is added.
  const capacities = (metrics || []).filter(metric => metric.kind !== 'feature');

  const ceiling = metric => metric.maximum_allowed || {};
  const isOwn = metric => ceiling(metric).source === 'override';

  // Prefilled in the same unit the plan sheet asks for. A person selling storage
  // types 25 and means gigabytes; `toStored` is the one place that conversion
  // happens, so this asks the same question the plan does and gets the same
  // answer rather than a second convention that can disagree with it.
  const inGigabytes = metric => BY_GIGABYTE.has(metric.metric);
  const open = metric => {
    const ceil = ceiling(metric);
    setEditing(metric.metric);
    setAmount(ceil.unlimited ? '' : String(inGigabytes(metric)
      ? Math.round(((ceil.value || 0) / GIGABYTE) * 100) / 100
      : (ceil.value ?? '')));
    setReason('');
  };

  const save = async metricKey => {
    setBusy(true);
    try {
      await api.setLimit(account.id, metricKey,
        { value: toStored({ metric: metricKey }, amount), reason: reason.trim() });
      setEditing(null);
      await onChanged();
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const clear = async metricKey => {
    setBusy(true);
    try { await api.clearLimit(account.id, metricKey); setEditing(null); await onChanged(); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  // A Community box has no plans; the box puts somebody on its one plan for
  // everybody the first time they are given a number, so there is nothing to ask.
  if (hosting && !account.package) {
    return (
      <section className="details-section">
        <h3 className="details-section__title"><Icon name="upload" size={14} />A number of their own</h3>
        <p className="details-hint">
          Put them on a plan first. An override changes what a plan gave them, so there has to be one.
        </p>
      </section>
    );
  }

  return (
    <section className="details-section">
      <h3 className="details-section__title"><Icon name="upload" size={14} />A number of their own</h3>
      <p className="details-hint">
        {hosting
          ? 'Give this one account a different limit without inventing a package for it. It is bounded by what you hold yourself, and the reason is on the record because somebody will ask.'
          : 'Give this person a limit of their own. Everyone else keeps what this box gives by default. The reason is on the record because somebody will ask.'}
      </p>
      {capacities.length === 0 && <p className="details-empty">Reading…</p>}
      {capacities.map(metric => {
        const key = metric.metric;
        const own = isOwn(metric);
        return (
          <div className="limit-row" key={key}>
            <div className="limit-row__head">
              <span className="limit-row__label">{label(key)}</span>
              <span className={`limit-row__value${own ? ' limit-row__value--own' : ''}`}>
                {entitlementWords(metric)}{own ? ' · theirs alone' : (hosting ? ' · from the plan' : ' · the default')}
              </span>
              <Button onClick={() => (editing === key ? setEditing(null) : open(metric))} disabled={busy}>
                {editing === key ? 'Cancel' : (own ? 'Change' : 'Give a number')}
              </Button>
            </div>
            {own && metric.override_reason && <p className="details-hint">{metric.override_reason}</p>}
            {editing === key && (
              <form className="limit-row__form" onSubmit={event => { event.preventDefault(); save(key); }}>
                <Field label={inGigabytes(metric) ? 'Limit, in gigabytes' : 'Limit'}
                  value={amount} onChange={event => setAmount(event.target.value)}
                  hint={inGigabytes(metric)
                    ? (hosting ? 'The same unit the plan asks for. It is stored and enforced in bytes.' : 'Stored and enforced in bytes.')
                    : 'A count.'} />
                <Field label="Why" value={reason} onChange={event => setReason(event.target.value)}
                  hint="Required, and on the record against this account. Somebody will ask." />
                <div className="console-form__actions">
                  <Button kind="solid" type="submit" disabled={busy || !amount.trim() || !reason.trim()}>Set it</Button>
                  {own && <Button type="button" onClick={() => clear(key)} disabled={busy}>{hosting ? 'Back to the plan' : 'Back to the default'}</Button>}
                </div>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}

// Ending an account, which is not deleting it.
//
// The sheet has to carry the whole promise, because a hosting company pressing
// this is about to take somebody off the box and the thing that makes that safe
// is not a warning, it is what actually happens: the files are sealed and proved
// before anything is removed, and they are still here afterwards. So this says
// that rather than shouting.
//
// The address is typed out to confirm. Not theatre — an account list is a column
// of near-identical rows, and this is the one action in the console that cannot
// be undone by pressing the other button.
// Suspension, which names one account and stops that one.
//
// Settled and not a gap: a suspended reseller loses their console — no
// onboarding, no managing, no selling — and their customers go on working,
// because those customers did nothing wrong, are still paying somebody, and are
// the asset in this situation rather than the leverage.
//
// So there is no second question here and no box to tick. A hosting company
// whose reseller stops paying takes those customers over instead, one at a time,
// from the list on that reseller's own sheet — which is the section directly
// below this one.
function Suspension({ account, busy, onSuspend }) {
  return (
    <section className="details-section">
      <h3 className="details-section__title"><Icon name="warning" size={14} />Suspension</h3>
      <p className="details-hint">
        Suspension stops every way in — the API, published files and share links — and destroys nothing. Restoring gives it all back.
      </p>
      {(account.customers || 0) > 0 && (
        <p className="details-hint">
          This stops this account alone. The {account.customers} account{account.customers === 1 ? '' : 's'} they
          sell to keep working, because they did nothing wrong and are still paying somebody. To take those over,
          move them below.
        </p>
      )}
      <Button kind={account.suspended ? 'solid' : 'danger'} onClick={onSuspend} disabled={busy}>
        {account.suspended ? 'Let them back in' : 'Suspend this account'}
      </Button>
    </section>
  );
}

function AccountEnd({ account, keeper, onEnded, onError }) {
  const [typed, setTyped] = useState('');
  const [keepDays, setKeepDays] = useState('365');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { setTyped(''); setOpen(false); }, [account.id]);

  const ready = typed.trim().toLowerCase() === String(account.email).toLowerCase();

  const end = async event => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const out = await api.terminateAccount(account.id, keepDays.trim() ? Number(keepDays) : null);
      await onEnded(out);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  return (
    <section className="details-section">
      <h3 className="details-section__title"><Icon name="trash" size={14} />Ending the account</h3>
      <p className="details-hint">
        Terminating seals this account's files into an archive, proves the archive is intact, and only
        then takes the account off this box.{' '}
        {/* Archives are the box owner's (the Archives section is theirs alone), so a
            reseller who terminates makes one they cannot see or hand back. */}
        {keeper
          ? "Nothing is deleted: the archive stays on your disk, off this customer's meter and on yours, and you can hand it back if they come asking."
          : "Nothing is deleted: the archive is kept by the company that runs this box, and they can hand it back if this customer comes asking."}
      </p>
      {account.customers > 0 && (
        <Note tone="quiet">
          This account sells to {account.customers} of their own. Move them to yourself or to another of your
          resellers under &ldquo;Who they sell to&rdquo; above, or terminate them one at a time — this box will
          not decide what happens to somebody else&apos;s customers. Terminating a reseller who still has
          customers would end paying accounts to collect somebody else&apos;s debt.
        </Note>
      )}
      {!open && account.customers === 0 && (
        <Button kind="danger" onClick={() => setOpen(true)}>Terminate this account</Button>
      )}
      {open && (
        <form onSubmit={end}>
          <Field
            label="Type the address to confirm"
            value={typed}
            onChange={event => setTyped(event.target.value)}
            autoFocus
            hint={`${account.email}. This is the one action here that the other button cannot undo.`}
          />
          <Field
            label="Keep the archive for, in days"
            value={keepDays}
            onChange={event => setKeepDays(event.target.value)}
            hint="Leave it empty to set no end. Holding a former customer's data for ever is a decision somebody should make on purpose."
          />
          <div className="console-form__actions">
            <Button kind="danger" type="submit" disabled={!ready || busy}>
              {busy ? 'Sealing and proving…' : 'Terminate and archive'}
            </Button>
            <Button type="button" onClick={() => { setOpen(false); setTyped(''); }}>Not now</Button>
          </div>
        </form>
      )}
    </section>
  );
}

// What the archives cost, and what they are worth.
//
// A hosting company looks at this for two opposite reasons on the same screen:
// it is disk they are paying for, and it is the thing a returning customer pays
// them to hand back. So the count and the size lead, and every row can be proved
// without being opened.
//
// Sealed rather than browsable, deliberately. There is no file list here and no
// way to ask for one: it holds a former customer's documents, and the boundary
// is the same one the audit trail draws.
function Archives({ archives, total, busy, onVerify, onRestore, onDestroy }) {
  const [proved, setProved] = useState({});
  const [confirming, setConfirming] = useState(null);
  const [typed, setTyped] = useState('');

  const [handed, setHanded] = useState({});

  const verify = async one => {
    const out = await onVerify(one.id);
    setProved(current => ({ ...current, [one.id]: out }));
  };

  // Handing an archive back leaves the row exactly as it was — the archive is
  // still held, which is correct — so without a word here the operator clicks
  // the thing they charge for and sees nothing happen. Silence reads as failure,
  // and the next click is the same click.
  const handBack = async one => {
    const out = await onRestore(one.id);
    if (out && out.account) {
      setHanded(current => ({ ...current, [one.id]: out }));
      setProved(current => ({ ...current, [one.id]: null }));
    }
  };

  return (
    <>
      <header className="console-head">
        <div>
          <h1>Archives</h1>
          <p>
            Terminated accounts, sealed and kept. This is your disk and their documents: a cost while you
            hold it, and what you hand back when somebody returns.
          </p>
        </div>
        <div className="console-total">
          <strong>{total.count}</strong>
          <span>{bytes(total.bytes || 0)}</span>
        </div>
      </header>

      {archives.length === 0 && (
        <Note tone="quiet">Nothing has been terminated on this box.</Note>
      )}

      {archives.map(one => (one.status === 'unreadable' ? (
        // An archive on the disk that this box cannot read. It gets a card of
        // its own rather than a row with blanks in it, because every fact the
        // normal card shows — whose it was, how big, when it may go — is
        // exactly what cannot be known here, and printing "0 files" over it
        // would be a confident lie about somebody's only copy. There is no
        // Verify and no Restore, because there is nothing to run them against.
        <article className="archive archive--unreadable" key={one.directory}>
          <div className="archive__who">
            <strong>An archive this box cannot read</strong>
          </div>
          <Note tone="bad">
            {one.problem} It is still on the disk at <code>{one.directory}</code> and nothing here has
            touched it. Whoever runs this machine should look before anything is deleted.
          </Note>
        </article>
      ) : (
        <article className="archive" key={one.id}>
          <div className="archive__who">
            <strong>{(one.account || {}).name || 'An account'}</strong>
            <span className="console-muted">{(one.account || {}).email || 'address not recorded'}</span>
          </div>
          <dl className="fact-list">
            <div className="fact-list__row"><dt>Sealed</dt><dd>{when(one.created_at)}</dd></div>
            <div className="fact-list__row"><dt>Holding</dt><dd>{one.files} file{one.files === 1 ? '' : 's'}, {bytes(one.bytes || 0)}</dd></div>
            <div className="fact-list__row">
              <dt>Keep until</dt>
              <dd>
                {one.keep_until ? when(one.keep_until) : 'nobody has said'}
                {one.keep_expired && <span className="archive__due"> · past its date</span>}
              </dd>
            </div>
          </dl>
          {handed[one.id] && (
            <Note tone="good">
              Handed back as {handed[one.id].account.email} — {handed[one.id].files} file
              {handed[one.id].files === 1 ? '' : 's'}, {bytes(handed[one.id].bytes || 0)}. The archive is still
              here; delete it when you are ready.
            </Note>
          )}
          {proved[one.id] && (
            <Note tone={proved[one.id].ok ? 'good' : 'bad'}>
              {proved[one.id].ok
                ? `Intact. ${proved[one.id].files_checked} file${proved[one.id].files_checked === 1 ? '' : 's'} checked, hash for hash.`
                : (proved[one.id].problems || []).join('; ')}
            </Note>
          )}
          <div className="console-form__actions">
            <Button onClick={() => verify(one)} disabled={busy}>Prove it is intact</Button>
            <Button onClick={() => handBack(one)} disabled={busy}>Hand it back</Button>
            <Button kind="danger" onClick={() => { setConfirming(confirming === one.id ? null : one.id); setTyped(''); }} disabled={busy}>
              {confirming === one.id ? 'Cancel' : 'Delete for ever'}
            </Button>
          </div>
          {confirming === one.id && (
            <form
              className="archive__destroy"
              onSubmit={event => { event.preventDefault(); onDestroy(one.id); setConfirming(null); }}
            >
              <Field
                label="Type: delete for ever"
                value={typed}
                onChange={event => setTyped(event.target.value)}
                autoFocus
                hint="This is the only thing in this product that loses a customer's files. There is no other copy."
              />
              <Button kind="danger" type="submit" disabled={busy || typed.trim() !== 'delete for ever'}>
                Delete this archive for ever
              </Button>
            </form>
          )}
        </article>
      )))}
    </>
  );
}

function NewAccountSheet({ role, busy, onClose, onDone }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const set = key => event => setForm({ ...form, [key]: event.target.value });
  const ready = form.name.trim() && form.email.trim() && form.password.length >= 12;
  return (
    <Sheet
      title={role === 'reseller' ? 'New reseller' : (hosting ? 'New customer' : 'Add a person')}
      eyebrow={role === 'reseller' ? 'They will sell below you, with the same machinery' : (hosting ? 'One level down from you' : 'They sign in with this address')}
      onClose={onClose}
    >
      <form onSubmit={event => { event.preventDefault(); if (ready) onDone({ ...form, role }); }}>
        <Field label="Name" value={form.name} onChange={set('name')} autoFocus required />
        <Field label="Email" type="email" value={form.email} onChange={set('email')} required
          hint="They confirm this address before the account works. Nothing is sent until you create it." />
        <Field label="First password" type="password" value={form.password} onChange={set('password')} required minLength={12}
          hint="Twelve characters or more. They can change it themselves at any time, and should." />
        <div className="console-form__actions">
          <Button kind="solid" type="submit" disabled={busy || !ready}>
            {role === 'reseller' ? 'Create the reseller' : (hosting ? 'Create the customer' : 'Add them')}
          </Button>
          <Button type="button" onClick={onClose}>Not now</Button>
        </div>
      </form>
    </Sheet>
  );
}
