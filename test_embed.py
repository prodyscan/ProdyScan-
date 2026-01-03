from engines.free_embedder import FreeEmbedder
from PIL import Image
import numpy as np

print("=== Test FreeEmbedder ===")

# Charger le modèle
E = FreeEmbedder()
print("Modèle chargé OK")

# Charger les images
img1 = Image.open("test1.png").convert("RGB")
img2 = Image.open("test2.png").convert("RGB")

# Embeddings
v1 = E.embed_image(img1)
v2 = E.embed_image(img2)

v1 = np.array(v1).astype("float32")
v2 = np.array(v2).astype("float32")

print("Shape v1 =", v1.shape)
print("Shape v2 =", v2.shape)

# Distance
dist = np.linalg.norm(v1 - v2)
print("Distance entre images =", dist)