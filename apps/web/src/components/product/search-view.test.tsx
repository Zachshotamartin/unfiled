import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchView } from "./search-view";

describe("SearchView", () => {
  it("renders a bounded client-submitted search form without a URL query action", () => {
    const html = renderToStaticMarkup(<SearchView />);

    expect(html).toContain('role="search"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('value=""');
    expect(html).not.toContain("/api/v1/search?");
    expect(html).not.toContain("/app/search?");
    expect(html).not.toContain('name="q"');
  });
});
