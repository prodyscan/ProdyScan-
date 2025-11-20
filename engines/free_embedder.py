import numpy as np
import torch
from PIL import Image
import open_clip


class FreeEmbedder:
    """
    Modèle gratuit pour générer des embeddings d'image.
    Utilise OpenCLIP ViT-B-32.
    """

    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai"
        )
        self.model.to(self.device)
        self.model.eval()

    def embed_image(self, image: Image.Image) -> np.ndarray:
        img = self.preprocess(image).unsqueeze(0).to(self.device)

        with torch.no_grad():
            vec = self.model.encode_image(img)
            vec = vec / vec.norm(dim=-1, keepdim=True)  # normalisation cosinus

        return vec.cpu().numpy()[0].astype("float32")
