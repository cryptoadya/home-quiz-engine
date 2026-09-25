import { Navigate, Route, Routes } from 'react-router-dom';
import { QuizEditor, QuizList } from './Admin';

const interfaces = [
  { path: '/host', title: 'Host', description: 'Game controls' },
  { path: '/screen', title: 'Screen', description: 'TV presentation' },
  { path: '/play', title: 'Player', description: 'Phone answers' },
] as const;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin" element={<QuizList />} />
      <Route path="/admin/quizzes/:quizId" element={<QuizEditor />} />
      {interfaces.map(({ path, title, description }) => (
        <Route
          key={path}
          path={path}
          element={<main><h1>{title}</h1><p>{description} interface coming in a later phase.</p></main>}
        />
      ))}
      <Route path="*" element={<main><h1>Page not found</h1></main>} />
    </Routes>
  );
}
