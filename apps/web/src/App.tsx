import { ScreenCheck } from './ScreenCheck';
import { RoomEntry } from './RoomEntry';
import { RoomRoute } from './RoomRoute';
import { Play } from './Play';
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
      <Route path="/screen-check/:quizId" element={<ScreenCheck />} />
      <Route path="/screen/:roomId" element={<RoomRoute destination="screen" />} />
      <Route path="/host/:roomId" element={<RoomRoute destination="host" />} />
      <Route path="/host" element={<RoomEntry destination="host" />} />
      <Route path="/screen" element={<RoomEntry destination="screen" />} />
      <Route path="*" element={<main><h1>Page not found</h1></main>} />
    </Routes>
  );
}
