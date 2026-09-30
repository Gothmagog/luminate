import {ScatterCanvasView} from './ui/scatter-canvas-view/scatter-canvas-view';
import { LuminateAppBar } from './ui/app-bar/app-bar';
import { ToastContainer } from './ui/toasts';
import { WelcomeModal } from './ui/welcome-modal';
import Editor from './ui/editor/text-editor';
import AiForm from './ui/editor/ai-panel/ai-form';
import React, { useEffect, useState } from 'react';
import { startTutorial } from './util/util';

function App() {
  return (
    <div className="Luminate">
      <LuminateAppBar />
      <div className="container-fluid">
        <div className="text-editor-container" id="text-editor-container">
          <Editor />
        </div>
        <div className="ai-panel" id="ai-panel">
            <AiForm responseHandler={null} selectedContent={null} api={null}/>
        </div>
        <div className="scatter-filter-container" id="scatter-filter-container" style={{display: 'none'}}></div>
        <div id="my-spaceviz">
            <ScatterCanvasView />
        </div>
      </div>
      <ToastContainer />
    </div>
  )
}

export default App
