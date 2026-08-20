import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

interface ErrorBoundaryState {
  failed: boolean;
}

class TaskboardErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Taskboard render failed", error, info.componentStack);
  }

  private returnToBoard = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("issue");
    window.history.replaceState(window.history.state, "", url);
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="fatal-error" role="alert">
        <section className="fatal-error-panel">
          <span className="fatal-error-mark" aria-hidden="true">!</span>
          <h1>任务面板暂时无法显示</h1>
          <p>界面发生异常，任务数据不会丢失。</p>
          <div className="fatal-error-actions">
            <button type="button" onClick={this.returnToBoard}>返回看板</button>
            <button className="primary" type="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </div>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TaskboardErrorBoundary>
      <App />
    </TaskboardErrorBoundary>
  </StrictMode>,
);
