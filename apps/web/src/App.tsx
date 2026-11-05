import { Home } from './components/Home';
import { RoomPage } from './components/RoomPage';
import { roomCodeFromPath, usePath } from './lib/router';

export function App() {
  const path = usePath();
  const code = roomCodeFromPath(path);
  return code ? <RoomPage code={code} /> : <Home />;
}
