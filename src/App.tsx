import React from 'react';
import routerConfig from "./router";
import { BrowserRouter, useRoutes } from "react-router-dom";

const RouterBox: React.FC = () => {

  const routeElement = useRoutes(routerConfig);

  return <div className="router-nav">{routeElement}</div>
}

const App: React.FC = () => {
  return (
    <div className="App">
      
      <header className='app-header'></header>
      <nav className='app-nav'>
        <BrowserRouter>
          <RouterBox />
        </BrowserRouter>
      </nav>
      <footer className='app-footer'></footer>
    </div>
  );
}

export default App;
