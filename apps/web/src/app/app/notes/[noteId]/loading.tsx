/** A note's shape while it loads: the toolbar, the title, the first lines of the body. */
export default function NoteLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      aria-label="Loading the note"
      className="note-editor-page"
    >
      <div className="note-editor-main" aria-hidden="true">
        <div className="editor-toolbar">
          <div className="skeleton-block h-5 w-20" />
          <div className="ml-auto flex items-center gap-3">
            <div className="skeleton-block h-9 w-9 rounded-control" />
            <div className="skeleton-block h-9 w-9 rounded-control" />
            <div className="skeleton-block h-11 w-24 rounded-control" />
          </div>
        </div>
        <div className="editor-document">
          <div className="skeleton-block h-12 w-1/2 max-w-full rounded-control" />
          <div className="mt-8 grid gap-3">
            <div className="skeleton-block h-5 w-full" />
            <div className="skeleton-block h-5 w-11/12" />
            <div className="skeleton-block h-5 w-4/5" />
            <div className="skeleton-block h-5 w-2/3" />
          </div>
        </div>
      </div>
    </main>
  );
}
