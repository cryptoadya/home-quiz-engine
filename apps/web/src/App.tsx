import { RoomEntry } from './RoomEntry';
import { Screen } from './Screen';
import { Play } from './Play';
import { Host } from './Host';
import { Navigate, Route, Routes } from 'react-router-dom';
import { QuizEditor, QuizList } from './Admin';
import { History } from './History';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin" element={<QuizList />} />
      <Route path="/admin/history" element={<History />} />
      <Route path="/admin/quizzes/:quizId" element={<QuizEditor />} />
      <Route path="/play" element={<Play />} />
      <Route path="/play/:code" element={<Play />} />
      <Route path="/screen/:roomId" element={<Screen />} />
      <Route path="/host/:roomId" element={<Host />} />
      <Route path="/host" element={<RoomEntry destination="host" />} />
      <Route path="/screen" element={<RoomEntry destination="screen" />} />
      <Route path="*" element={<main><h1>Page not found</h1></main>} />
    </Routes>
  );
}
