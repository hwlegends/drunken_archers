import { useEffect, useRef, useState } from 'react';
import { useNetStore } from '../net/netStore';
import type { LobbyPlayer } from '../net/protocol';

interface LobbyPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Round trip to the opponent, once a match is running. */
  latency: number | null;
  onLeaveMatch: () => void;
}

const STATUS_LABEL = {
  offline: 'Offline',
  connecting: 'Connecting',
  online: 'Connected',
} as const;

/**
 * The right-hand panel: who else has this game open, and the challenges going
 * back and forth. It is the only part of the interface that exists outside the
 * 16:9 stage, because it is the only part that is not the game.
 */
export function LobbyPanel({ collapsed, onToggle, latency, onLeaveMatch }: LobbyPanelProps) {
  const status = useNetStore((s) => s.status);
  const selfName = useNetStore((s) => s.selfName);
  const players = useNetStore((s) => s.players);
  const incoming = useNetStore((s) => s.incoming);
  const outgoing = useNetStore((s) => s.outgoing);
  const match = useNetStore((s) => s.match);
  const notice = useNetStore((s) => s.notice);
  const lobbyUrl = useNetStore((s) => s.lobbyUrl);

  const [showServer, setShowServer] = useState(false);

  if (collapsed) {
    // A challenge expires when the other player gives up waiting, so the rail
    // has to say one is waiting even though it has no room to say who from.
    const pending = incoming.length > 0;
    return (
      <button
        className="lobby-tab"
        data-alert={pending}
        onClick={onToggle}
        aria-label={pending ? incoming.length + ' challenges waiting' : 'Show players'}
        data-ui-control
      >
        <span className={'dot dot--' + status} aria-hidden="true" />
        <span className="lobby-tab__count">{pending ? '!' : players.length}</span>
        <span className="lobby-tab__label">{pending ? 'Challenged' : 'Players'}</span>
      </button>
    );
  }

  return (
    <aside className="lobby" aria-label="Online players">
      <header className="lobby__head">
        <h2 className="lobby__title">
          <span className={'dot dot--' + status} aria-hidden="true" />
          Players
        </h2>
        <button className="lobby__collapse" onClick={onToggle} aria-label="Hide players" data-ui-control>
          ›
        </button>
      </header>

      <NameField value={selfName} />

      {status !== 'online' && (
        <p className="lobby__empty">
          {STATUS_LABEL[status]}
          {status === 'offline' ? ' — retrying. Is the lobby server running?' : '…'}
        </p>
      )}

      {match ? (
        <div className="lobby__match">
          <p className="lobby__matchline">
            Playing <b>{match.opponent.name}</b>
          </p>
          <p className="lobby__meta">
            You are {match.side === 'left' ? 'Cobalt' : 'Ember'}
            {match.role === 'host' ? ' · hosting' : ''}
            {latency !== null ? ' · ' + latency + 'ms' : ''}
          </p>
          <button className="btn btn--danger btn--small" onClick={onLeaveMatch} data-ui-control>
            Leave match
          </button>
        </div>
      ) : (
        <>
          {incoming.map((player) => (
            <ChallengeCard key={player.id} player={player} />
          ))}

          <ul className="lobby__list">
            {players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                pending={outgoing.includes(player.id)}
              />
            ))}
          </ul>

          {status === 'online' && players.length === 0 && (
            <p className="lobby__empty">
              Nobody else is here yet. Open this address on the other computer to
              show up in each other's list.
            </p>
          )}
        </>
      )}

      {notice && <p className="lobby__notice">{notice}</p>}

      <div className="lobby__foot">
        <button className="lobby__link" onClick={() => setShowServer((v) => !v)} data-ui-control>
          {showServer ? 'Hide server' : 'Server'}
        </button>
        {showServer && <ServerField value={lobbyUrl} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function PlayerRow({ player, pending }: { player: LobbyPlayer; pending: boolean }) {
  const challenge = useNetStore((s) => s.challenge);
  const withdraw = useNetStore((s) => s.withdraw);
  const busy = player.status === 'inMatch';

  return (
    <li className="player">
      <span className="player__name" title={player.name}>
        {player.name}
      </span>
      {busy ? (
        <span className="player__badge">In a match</span>
      ) : pending ? (
        <button
          className="btn btn--ghost btn--small"
          onClick={() => withdraw(player.id)}
          data-ui-control
        >
          Waiting · cancel
        </button>
      ) : (
        <button
          className="btn btn--primary btn--small"
          onClick={() => challenge(player.id)}
          data-ui-control
        >
          Challenge
        </button>
      )}
    </li>
  );
}

function ChallengeCard({ player }: { player: LobbyPlayer }) {
  const accept = useNetStore((s) => s.accept);
  const decline = useNetStore((s) => s.decline);

  return (
    <div className="invite">
      <p className="invite__text">
        <b>{player.name}</b> wants to duel.
      </p>
      <div className="invite__row">
        <button className="btn btn--accent btn--small" onClick={() => accept(player.id)} data-ui-control>
          Accept
        </button>
        <button className="btn btn--ghost btn--small" onClick={() => decline(player.id)} data-ui-control>
          Decline
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editable fields
 * ------------------------------------------------------------------ */

/**
 * Committed on blur or Enter rather than on every keystroke, so a rename is one
 * message and one list broadcast instead of one per letter typed.
 */
function NameField({ value }: { value: string }) {
  const setName = useNetStore((s) => s.setName);
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = () => {
    editing.current = false;
    if (draft.trim()) setName(draft);
    else setDraft(value);
  };

  return (
    <label className="field">
      <span className="field__label">Your name</span>
      <input
        className="field__input"
        value={draft}
        maxLength={18}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        data-ui-control
      />
    </label>
  );
}

function ServerField({ value }: { value: string }) {
  const setLobbyUrl = useNetStore((s) => s.setLobbyUrl);
  const [draft, setDraft] = useState(value);

  return (
    <label className="field">
      <span className="field__label">Lobby address</span>
      <input
        className="field__input field__input--mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setLobbyUrl(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        spellCheck={false}
        data-ui-control
      />
    </label>
  );
}
