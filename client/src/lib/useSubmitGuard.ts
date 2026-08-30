import { useRef } from 'react';

export function useSubmitGuard() {
  const inFlightRef = useRef(false);

  const beginSubmit = () => {
    if (inFlightRef.current) {
      return false;
    }

    inFlightRef.current = true;
    return true;
  };

  const endSubmit = () => {
    inFlightRef.current = false;
  };

  return {
    beginSubmit,
    endSubmit,
    inFlightRef,
  };
}
