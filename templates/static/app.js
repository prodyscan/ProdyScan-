function uploadImage() {
    const file = document.getElementById("fileInput").files[0];
    if (!file) {
        alert("Sélectionne une image !");
        return;
    }

    const formData = new FormData();
    formData.append("image", file);

    fetch("/scan", {
        method: "POST",
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        document.getElementById("result").innerText = JSON.stringify(data);
    })
    .catch(err => {
        alert("Erreur: " + err);
    });
}
