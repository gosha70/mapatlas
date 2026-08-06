// SPDX-License-Identifier: Apache-2.0

/**
 * `<EventComposer>` (tasks T5.3): a comment field plus in-place photo capture.
 *
 * Photos are captured with `<input type="file" accept="image/*"
 * capture="environment">`. If a {@link StorageAdapter} is provided the bytes are
 * persisted via `putBlob` and referenced by `blobKey` (durable, survives
 * reload); otherwise an object URL is used. If a {@link MediaAnalyzer} is
 * provided an "Analyze photo" action yields *suggested* labels the user
 * explicitly confirms before they become event tags. When the analyzer
 * `runsRemotely`, a disclosure is shown before any bytes leave the device
 * (ADR-0005).
 *
 * The `store` prop is an addition to the api.md §7 signature — see ADR-0009.
 */
import { useCallback, useState } from "react";
import type {
  MapEvent,
  MediaAnalysis,
  MediaAnalyzer,
  MediaRef,
  StorageAdapter,
} from "@mapatlas/core";
import { newId } from "@mapatlas/core";

export interface EventComposerProps {
  /** where the event will be pinned (supplied by the parent map) */
  at: { lat: number; lng: number };
  analyzer?: MediaAnalyzer;
  /** optional persistence for captured photo bytes (ADR-0009) */
  store?: StorageAdapter;
  onSave(input: Omit<MapEvent, "id" | "position">): void;
  onCancel(): void;
}

interface PhotoItem {
  ref: MediaRef;
  blob: Blob;
  previewUrl?: string;
  suggestions?: MediaAnalysis["labels"];
  confirmed: Set<string>;
  analyzed: boolean;
  analyzing: boolean;
}

function makePreview(blob: Blob): string | undefined {
  const u = globalThis.URL;
  return typeof u?.createObjectURL === "function"
    ? u.createObjectURL(blob)
    : undefined;
}

export function EventComposer(props: EventComposerProps): JSX.Element {
  const { analyzer, store } = props;
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [saving, setSaving] = useState(false);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const added: PhotoItem[] = [];
      for (const file of Array.from(files)) {
        const ref: MediaRef = { id: newId(), mime: file.type || "image/jpeg" };
        if (store) {
          ref.blobKey = await store.putBlob(file);
        }
        const preview = makePreview(file);
        if (preview && !ref.blobKey) ref.url = preview;
        const item: PhotoItem = {
          ref,
          blob: file,
          confirmed: new Set<string>(),
          analyzed: false,
          analyzing: false,
        };
        if (preview) item.previewUrl = preview;
        added.push(item);
      }
      setPhotos((prev) => [...prev, ...added]);
    },
    [store],
  );

  const analyze = useCallback(
    async (index: number) => {
      if (!analyzer) return;
      setPhotos((prev) =>
        prev.map((p, i) => (i === index ? { ...p, analyzing: true } : p)),
      );
      const item = photos[index];
      if (!item) return;
      const analysis = await analyzer.analyze({ blob: item.blob });
      setPhotos((prev) =>
        prev.map((p, i) =>
          i === index
            ? {
                ...p,
                analyzing: false,
                analyzed: true,
                suggestions: analysis.labels,
                ref: { ...p.ref, analysis },
              }
            : p,
        ),
      );
    },
    [analyzer, photos],
  );

  const toggleLabel = useCallback((index: number, label: string) => {
    setPhotos((prev) =>
      prev.map((p, i) => {
        if (i !== index) return p;
        const confirmed = new Set(p.confirmed);
        if (confirmed.has(label)) confirmed.delete(label);
        else confirmed.add(label);
        return { ...p, confirmed };
      }),
    );
  }, []);

  const save = useCallback(() => {
    setSaving(true);
    const tags = Array.from(
      new Set(photos.flatMap((p) => Array.from(p.confirmed))),
    );
    const media = photos.map((p) => p.ref);
    const input: Omit<MapEvent, "id" | "position"> = {
      occurredAt: Date.now(),
      media,
      tags,
    };
    const trimmed = comment.trim();
    if (trimmed) input.comment = trimmed;
    props.onSave(input);
  }, [comment, photos, props]);

  return (
    <form
      className="mapatlas-event-composer"
      aria-label="New map event"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label>
        <span>Comment</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What did you see here?"
        />
      </label>

      <label>
        <span>Add photo</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => void onFiles(e.target.files)}
          data-testid="photo-input"
        />
      </label>

      {analyzer?.runsRemotely && (
        <p role="note" className="mapatlas-remote-disclosure">
          Heads up: the analyzer “{analyzer.id}” runs remotely. Choosing
          “Analyze photo” sends the image off your device.
        </p>
      )}

      <ul className="mapatlas-photo-list">
        {photos.map((p, i) => (
          <li key={p.ref.id} className="mapatlas-photo">
            {p.previewUrl && (
              <img src={p.previewUrl} alt="Captured" width={64} height={64} />
            )}
            {analyzer && (
              <button
                type="button"
                onClick={() => void analyze(i)}
                disabled={p.analyzing}
              >
                {p.analyzing ? "Analyzing…" : "Analyze photo"}
              </button>
            )}
            {p.analyzed && (
              <div className="mapatlas-suggestions">
                {p.suggestions && p.suggestions.length > 0 ? (
                  <fieldset>
                    <legend>Suggested labels (confirm to keep)</legend>
                    {p.suggestions.map((s) => (
                      <label key={s.label}>
                        <input
                          type="checkbox"
                          checked={p.confirmed.has(s.label)}
                          onChange={() => toggleLabel(i, s.label)}
                        />
                        {s.label} ({Math.round(s.confidence * 100)}%)
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <span>No labels suggested.</span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mapatlas-composer-actions">
        <button type="submit" disabled={saving}>
          Save event
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
