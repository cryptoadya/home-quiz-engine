import { ThemeSurface } from './themes/ThemeSurface';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

type HistoryEntry = {
  tiebreak?: { completed: boolean; winnerIds: string[] };
  sessionId: string;
  completedAt: string;
  quizId: string | null;
  quizTitle: string;
  players: { playerId: string; displayName: string; totalPoints: number }[];
};

export function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch('/api/history').then(async response => {
      if (!response.ok) throw new Error('Unable to load history.');
      const items: HistoryEntry[] = await response.json();
      if (active) setEntries(items);
    }).catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <ThemeSurface className="admin history">
    <Link to="/admin">← Quiz list</Link>
    <header className="admin-header"><div><h1>History</h1><p>Latest 100 completed games.</p></div></header>
    {error ? <p role="alert" className="error">{error}</p> : loading ? <p>Loading history...</p> : entries.length === 0
      ? <p className="empty-state">No completed real games yet. Games appear here when final results are shown.</p>
      : <ul className="history-list">{entries.map(entry => <li key={entry.sessionId}>
        <h2>{entry.quizTitle}</h2>
        <p><time dateTime={entry.completedAt}>{new Date(entry.completedAt).toLocaleString()}</time></p>
        <p>Game: {entry.sessionId}<br />Original quiz: {entry.quizId ?? 'Unavailable (legacy game)'}</p>
        {entry.tiebreak && <p>{entry.tiebreak.completed ? `Tiebreak winners: ${entry.players.filter(p => entry.tiebreak!.winnerIds.includes(p.playerId)).map(p => p.displayName).join(', ')}` : 'Tiebreak in progress'}</p>}
        <table className="leaderboard"><caption>Final player scores</caption><thead><tr><th scope="col">Player</th><th scope="col">Points</th></tr></thead>
          <tbody>{entry.players.map(player => <tr key={player.playerId}><td>{player.displayName}</td><td>{player.totalPoints}</td></tr>)}</tbody>
        </table>
      </li>)}</ul>}
  </ThemeSurface>;
}
