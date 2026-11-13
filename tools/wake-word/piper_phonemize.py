"""Windows shim: piper-phonemize has no Windows wheels; piper-tts 1.3 bundles espeak-ng."""
from piper.phonemize_espeak import EspeakPhonemizer

_P = EspeakPhonemizer()


def phonemize_espeak(text, voice):
    return _P.phonemize(voice, text)
