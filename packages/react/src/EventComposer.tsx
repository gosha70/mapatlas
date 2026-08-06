// SPDX-License-Identifier: Apache-2.0
import { useCallback, useState } from "react";
import { newId } from "@mapatlas/core";
import type {
  LatLng,
  MapEvent,
  MediaAnalyzer,
  MediaRef,
  StorageAdapter,
} from "@mapatlas/core";

export interface EventComposerProps {
  at: LatLng;
  /** Optional AI analyzer. When present, an "Analyze photo" action is offered. */
  analyzer?: MediaAnalyzer;
  /**
   * Additive: when provided, captured photos are persisted via `putBlob` and
   * referenced by `blobKey` (durable across reload). Without a store, photos are
   * referenced by an in-memory object URL. (api.md §7 / ADR-0012.)
   */
  store?: StorageAdapter;
  onSave(input: Omit<MapEvent, "id" | "position">): void;
  onCancel(): void;
}

interface Suggestion {
  label: string;
  confidence: number;
}

interface CapturedPhoto {
  ref: MediaRef;
  file: File;
  previewUrl: string;
  analyzed: boolean;
  suggestions: Suggestion[];
  confirmed: Set<string>;
}

export function EventComposer(props: EventComposerProps): React.JSX.Element {
  const { at, analyzer, store, onSave, onCancel } = props;
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList) return;
      const added: CapturedPhoto[] = [];
      for (const file of Array.from(fileList)) {
        const ref: MediaRef = { id: newId(), mime: file.type || "image/*" };
        if (store) ref.blobKey = await store.putBlob(file);
        else ref.url = URL.createObjectURL(file);
        added.push({
          ref,
          file,
          previewUrl: URL.createObjectURL(file),
          analyzed: false,
          suggestions: [],
          confirmed: new Set<string>(),
        });
      }
      setPhotos((prev) => [...prev, ...added]);
    },
    [store],
  );

  const analyze = useCallback(
    async (photo: CapturedPhoto) => {
      if (!analyzer) return;
      setAnalyzingId(photo.ref.id);
      try {
        const result = await analyzer.analyze({ blob: photo.file });
        setPhotos((prev) =>
          prev.map((p) =>
            p.ref.id === photo.ref.id
              ? {
                  ...p,
                  analyzed: true,
                  suggestions: result.labels,
                  // The user confirms; default every suggestion to selected.
                  confirmed: new Set(result.labels.map((l) => l.label)),
                }
              : p,
          ),
        );
      } finally {
        setAnalyzingId(null);
      }
    },
    [analyzer],
  );

  const toggleLabel = useCallback((photoId: string, label: string) => {
    setPhotos((prev) =>
      prev.map((p) => {
        if (p.ref.id !== photoId) return p;
        const confirmed = new Set(p.confirmed);
        if (confirmed.has(label)) confirmed.delete(label);
        else confirmed.add(label);
        return { ...p, confirmed };
      }),
    );
  }, []);

  const save = useCallback(() => {
    const media: MediaRef[] = photos.map((p) => {
      const ref: MediaRef = { ...p.ref };
      const labels = p.suggestions.filter((s) => p.confirmed.has(s.label));
      if (labels.length > 0) {
        ref.analysis = analyzer ? { labels, model: analyzer.id } : { labels };
      }
      return ref;
    });
    const tags = [...new Set(photos.flatMap((p) => [...p.confirmed]))];
    const input: Omit<MapEvent, "id" | "position"> = {
      occurredAt: Date.now(),
      media,
      tags,
    };
    const trimmed = comment.trim();
    if (trimmed) input.comment = trimmed;
    onSave(input);
  }, [photos, comment, analyzer, onSave]);

  return (
    <form
      className="mapatlas-event-composer"
      aria-label="Compose map event"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="mapatlas-event-composer__location">
        At {at.lat.toFixed(5)}, {at.lng.toFixed(5)}
      </p>

      <label className="mapatlas-event-composer__comment">
        <span>Comment</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What happened here?"
        />
      </label>

      <label className="mapatlas-event-composer__capture">
        <span>Add photo</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => void onFiles(e.target.files)}
        />
      </label>

      {analyzer?.runsRemotely ? (
        <p role="note" className="mapatlas-event-composer__disclosure">
          “Analyze photo” sends this image to a remote service
          {analyzer.id ? ` (${analyzer.id})` : ""}. It leaves your device only
          when you choose to analyze.
        </p>
      ) : null}

      <ul className="mapatlas-event-composer__photos">
        {photos.map((p) => (
          <li key={p.ref.id} className="mapatlas-event-composer__photo">
            <img src={p.previewUrl} alt="Captured" width={96} height={96} />
            {analyzer ? (
              <button
                type="button"
                onClick={() => void analyze(p)}
                disabled={analyzingId === p.ref.id}
              >
                {analyzingId === p.ref.id ? "Analyzing…" : "Analyze photo"}
              </button>
            ) : null}
            {p.analyzed && p.suggestions.length === 0 ? (
              <p className="mapatlas-event-composer__no-labels">
                No labels suggested.
              </p>
            ) : null}
            {p.suggestions.length > 0 ? (
              <fieldset className="mapatlas-event-composer__labels">
                <legend>Suggested labels — confirm the ones that fit</legend>
                {p.suggestions.map((s) => (
                  <label key={s.label}>
                    <input
                      type="checkbox"
                      checked={p.confirmed.has(s.label)}
                      onChange={() => toggleLabel(p.ref.id, s.label)}
                    />
                    {s.label} ({Math.round(s.confidence * 100)}%)
                  </label>
                ))}
              </fieldset>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mapatlas-event-composer__actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
