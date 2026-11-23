import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  render(<App />, rootEl);
}
