import base64
from io import BytesIO
import numpy as np
from PIL import Image
from openai import OpenAI


class PremiumEmbedder:
    """
    Moteur premium (OpenAI Vision).
    Utilise des embeddings beaucoup plus puissants.
    """

    def __init__(self, api_key=None):
        self.client = OpenAI(api_key=api_key)

    def embed_image(self, image: Image.Image):
        buffer = BytesIO()
        image.save(buffer, format="JPEG")
        b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

        resp = self.client.embeddings.create(
            model="gpt-image-1",  # modèle à confirmer selon OpenAI
            input={"image": f"data:image/jpeg;base64,{b64}"},
        )

        emb = np.array(resp.data[0].embedding, dtype="float32")
        emb = emb / (np.linalg.norm(emb) + 1e-8)
        return emb
