import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function RoomEntry({ destination }: { destination: 'host' | 'screen' }) {
  const navigate = useNavigate();
  const [entered, setEntered] = useState('');
  const title = destination === 'host' ? 'Host' : 'Screen';
  return <main><h1>{title}</h1>
    <form className="fields" onSubmit={event => {
      event.preventDefault();
      const code = entered.trim().toUpperCase();
      if (code) navigate(`/${destination}/${encodeURIComponent(code)}`);
    }}>
      <label>Room code<input value={entered} onChange={event => setEntered(event.target.value)} required pattern="[ ]*[A-Za-z0-9]{5}[ ]*" autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></label>
      <button>Open {title}</button>
    </form>
  </main>;
}
