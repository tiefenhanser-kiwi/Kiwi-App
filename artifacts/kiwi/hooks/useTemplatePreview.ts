// WS7-4-B c7 — Hook that owns the open/close state of <PlanPreviewModal>.
// One useState slot holding the templateId being previewed (or null when
// closed). Returned API drives both the Plans tab (PlanRow source dispatcher
// -> open(id)) and the home discovery card (PlanCardSmall handlers).

import { useCallback, useState } from "react";

export interface UseTemplatePreviewResult {
  /** True iff a template is open. */
  visible: boolean;
  /** Id of the open template, or null when closed. */
  templateId: string | null;
  /** Open the modal for a given template id. */
  open: (id: string) => void;
  /** Close the modal. */
  close: () => void;
}

export function useTemplatePreview(): UseTemplatePreviewResult {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const open = useCallback((id: string) => setTemplateId(id), []);
  const close = useCallback(() => setTemplateId(null), []);
  return {
    visible: templateId !== null,
    templateId,
    open,
    close,
  };
}
